// functions/src/index.ts
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import {
  getFirestore,
  Timestamp,
  FieldValue,
} from "firebase-admin/firestore";

initializeApp();
const db = getFirestore();

/**
 * ★ 集計ドキュメント
 * meta/stats:
 *   voteCount: number
 *   totalLikes: number
 *   score: number   (voteCount*10 + totalLikes)
 */
const statsRef = db.collection("meta").doc("stats");

// ===== submitVote（ほぼ現状+ statsを自動復元/加算）=====
export const submitVote = onRequest(
  { region: "asia-northeast1" },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");

    if (req.method === "OPTIONS") return void res.status(204).send("");
    if (req.method !== "POST") {
      res.status(405).json({ code: "METHOD_NOT_ALLOWED", message: "Method Not Allowed" });
      return;
    }

    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        res.status(401).json({ code: "UNAUTHORIZED", message: "Unauthorized" });
        return;
      }

      const token = authHeader.replace("Bearer ", "");
      const decoded = await getAuth().verifyIdToken(token);
      const uid = decoded.uid;

      // body（v2対応）
      let rawMessage: unknown;
      if (req.rawBody) {
        try { rawMessage = JSON.parse(req.rawBody.toString("utf-8"))?.message; } catch { rawMessage = undefined; }
      } else if (typeof req.body === "string") {
        try { rawMessage = JSON.parse(req.body)?.message; } catch { rawMessage = undefined; }
      } else {
        rawMessage = req.body?.message;
      }

      if (typeof rawMessage !== "string") {
        res.status(400).json({ code: "INVALID_MESSAGE_TYPE", message: "message must be string" });
        return;
      }

      const message = rawMessage.trim();
      if (message.length === 0) {
        res.status(400).json({ code: "EMPTY", message: "空文字では送れません！" });
        return;
      }
      if (message.length > 20) {
        res.status(400).json({ code: "TOO_LONG", message: "20文字以内で入力してください" });
        return;
      }

      // 10分5件制限
      const WINDOW_MINUTES = 10;
      const LIMIT = 5;
      const tenMinutesAgo = Timestamp.fromDate(new Date(Date.now() - WINDOW_MINUTES * 60 * 1000));

      const recentVotesSnap = await db
        .collection("votes")
        .where("uid", "==", uid)
        .where("createdAt", ">=", tenMinutesAgo)
        .get();

      if (recentVotesSnap.size >= LIMIT) {
        res.status(429).json({
          code: "RATE_LIMIT",
          message: `${WINDOW_MINUTES}分間に送信できるのは${LIMIT}件までです`,
        });
        return;
      }

      // 保存
      const docRef = await db.collection("votes").add({
        uid,
        message,
        likeCount: 0,
        createdAt: Timestamp.now(),
      });

      // ★ statsを自動復元&加算（meta/statsが消えてても復活する）
      await statsRef.set(
        {
          voteCount: FieldValue.increment(1),
          score: FieldValue.increment(10),
          updatedAt: Timestamp.now(),
        },
        { merge: true }
      );

      logger.info("Vote saved", { id: docRef.id, uid });
      res.json({ ok: true, id: docRef.id });
    } catch (e) {
      logger.error(e);
      res.status(500).json({ code: "INTERNAL_ERROR", message: "サーバー内部エラー" });
    }
  }
);

/**
 * ===== likeVote（トグル式：1人1票=ON/OFF）
 * - votes/{voteId}/likes/{uid} を証拠にする
 * - users/{uid}/likes/{voteId} を作り、リロード復元できるようにする
 * - ONなら likeCount +1 / OFFなら -1
 * - stats(totalLikes/score) も連動して増減
 */
export const likeVote = onRequest(
  { region: "asia-northeast1" },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");

    if (req.method === "OPTIONS") return void res.status(204).send("");
    if (req.method !== "POST") {
      res.status(405).json({ code: "METHOD_NOT_ALLOWED", message: "Method Not Allowed" });
      return;
    }

    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        res.status(401).json({ code: "UNAUTHORIZED", message: "Unauthorized" });
        return;
      }

      const token = authHeader.replace("Bearer ", "");
      const decoded = await getAuth().verifyIdToken(token);
      const uid = decoded.uid;

      // body（v2対応）
      let rawVoteId: unknown;
      if (req.rawBody) {
        try { rawVoteId = JSON.parse(req.rawBody.toString("utf-8"))?.voteId; } catch { rawVoteId = undefined; }
      } else if (typeof req.body === "string") {
        try { rawVoteId = JSON.parse(req.body)?.voteId; } catch { rawVoteId = undefined; }
      } else {
        rawVoteId = req.body?.voteId;
      }

      if (typeof rawVoteId !== "string" || rawVoteId.trim().length === 0) {
        res.status(400).json({ code: "INVALID_VOTE_ID", message: "voteId must be string" });
        return;
      }

      const voteId = rawVoteId.trim();
      const voteRef = db.collection("votes").doc(voteId);
      const likeRef = voteRef.collection("likes").doc(uid);
      const userLikeRef = db.collection("users").doc(uid).collection("likes").doc(voteId);

      const result = await db.runTransaction(async (tx) => {
        const [voteSnap, likeSnap] = await Promise.all([tx.get(voteRef), tx.get(likeRef)]);
        if (!voteSnap.exists) throw new Error("NOT_FOUND");

        const cur = Math.max(0, Number(voteSnap.get("likeCount") ?? 0));
        const isLiked = likeSnap.exists;

        // ★ トグル：既に押してたら解除（-1）、押してなければ追加（+1）
        const delta = isLiked ? -1 : 1;
        const next = Math.max(0, cur + delta);

        if (isLiked) {
          tx.delete(likeRef);
          tx.delete(userLikeRef);
        } else {
          tx.set(likeRef, { createdAt: Timestamp.now() });
          tx.set(userLikeRef, { createdAt: Timestamp.now() });
        }

        tx.update(voteRef, { likeCount: next });

        // statsも連動（消えてても復活）
        tx.set(
          statsRef,
          {
            totalLikes: FieldValue.increment(delta),
            score: FieldValue.increment(delta),
            updatedAt: Timestamp.now(),
          },
          { merge: true }
        );

        return { likeCount: next, liked: !isLiked };
      });

      res.json({ ok: true, voteId, likeCount: result.likeCount, liked: result.liked });
    } catch (e: any) {
      if (e?.message === "NOT_FOUND") {
        res.status(404).json({ code: "NOT_FOUND", message: "vote not found" });
        return;
      }
      logger.error(e);
      res.status(500).json({ code: "INTERNAL_ERROR", message: "サーバー内部エラー" });
    }
  }
);
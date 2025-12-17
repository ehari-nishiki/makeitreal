// src/firebase.ts
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  getFirestore,
  collection,
  query,
  orderBy,
  limit,
  getDocs,
  getCountFromServer,
  doc,
  getDoc,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAYw79utxZHKNDfEvj7AhlR5Qvcxs2zV8o",
  authDomain: "hatofes-ecc25.firebaseapp.com",
  projectId: "hatofes-ecc25",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

const FN_BASE = "https://asia-northeast1-hatofes-ecc25.cloudfunctions.net";

export async function submitVote(message: string) {
  const user = auth.currentUser;
  if (!user) throw new Error("not signed in");

  const token = await user.getIdToken();
  const res = await fetch(`${FN_BASE}/submitVote`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message }),
  });

  if (!res.ok) {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      const msg = typeof parsed?.message === "string" ? parsed.message : text;
      throw new Error(msg);
    } catch {
      throw new Error(text);
    }
  }

  return await res.json();
}

export async function fetchVotes() {
  const q = query(collection(db, "votes"), orderBy("createdAt", "desc"), limit(80));
  const snap = await getDocs(q);
  return snap.docs.map((docu) => {
    const d: any = docu.data();
    return {
      id: docu.id,
      ...d,
      likeCount: typeof d.likeCount === "number" ? d.likeCount : 0,
    };
  });
}

export async function fetchVoteCount() {
  const snap = await getCountFromServer(collection(db, "votes"));
  return snap.data().count;
}

/**
 * ★ 自分が何にいいねしたか（リロード復元）
 * users/{uid}/likes/{voteId} が存在するvoteId一覧を返す
 */
export async function fetchMyLikes(): Promise<string[]> {
  const user = auth.currentUser;
  if (!user) return [];
  const uid = user.uid;

  const snap = await getDocs(collection(db, "users", uid, "likes"));
  return snap.docs.map((d) => d.id);
}

/**
 * ★ 集計（meta/stats）
 * 消しても Functions が勝手に復活させる設計
 */
export async function fetchStats(): Promise<{ voteCount: number; totalLikes: number; score: number } | null> {
  const snap = await getDoc(doc(db, "meta", "stats"));
  if (!snap.exists()) return null;
  const d: any = snap.data();
  return {
    voteCount: Number(d.voteCount ?? 0),
    totalLikes: Number(d.totalLikes ?? 0),
    score: Number(d.score ?? 0),
  };
}

/**
 * ★ いいねトグル（ON/OFF）
 * 戻り値の liked が「押した後の状態」
 */
export async function likeVote(voteId: string) {
  const user = auth.currentUser;
  if (!user) throw new Error("not signed in");
  const token = await user.getIdToken();

  const res = await fetch(`${FN_BASE}/likeVote`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ voteId }),
  });

  if (!res.ok) {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      throw new Error(parsed?.message ?? text);
    } catch {
      throw new Error(text);
    }
  }

  return (await res.json()) as {
    ok: true;
    voteId: string;
    likeCount: number;
    liked: boolean;
  };
}
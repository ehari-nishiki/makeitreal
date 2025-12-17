//main.tsx

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

import { signInAnonymously, onAuthStateChanged } from "firebase/auth";
import { auth } from "./firebase";

signInAnonymously(auth);

onAuthStateChanged(auth, (user) => {
  if (user) {
    console.log("UID:", user.uid);
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
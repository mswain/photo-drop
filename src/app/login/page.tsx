import { Suspense } from "react";
import { LoginForm } from "./login-form";
import { ThemeToggle } from "../theme-toggle";

export const metadata = { title: "Sign in · Photo Dump" };

export default function LoginPage() {
  return (
    <main className="center-screen">
      <div className="theme-toggle-floating">
        <ThemeToggle />
      </div>
      <div className="card container-narrow" style={{ width: "100%" }}>
        <h1>Photo Dump</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          Admin sign in
        </p>
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}

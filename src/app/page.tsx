import { redirect } from "next/navigation";

// The app has no public landing page; send visitors to the admin area, which
// the middleware will bounce to /login when unauthenticated.
export default function Home() {
  redirect("/admin");
}

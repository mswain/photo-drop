import { getSession } from "@/lib/session";
import { UsersManager } from "./users-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin users · Photo Drop" };

export default async function UsersPage() {
  const session = await getSession();
  return <UsersManager currentUserId={session?.sub ?? ""} />;
}

import { FoldersIndex } from "./folders-index";

export const dynamic = "force-dynamic";
export const metadata = { title: "Photos · Photo Dump" };

export default function AdminPhotosPage() {
  return <FoldersIndex />;
}

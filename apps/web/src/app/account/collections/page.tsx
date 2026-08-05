import { redirect } from "next/navigation";

export default async function AccountCollectionsPage() {
  redirect("/account#collections");
}

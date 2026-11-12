import { AdminDashboard } from "@/components/AdminDashboard";
import { requireAdminPage } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const authenticated = await requireAdminPage();
  return <AdminDashboard initiallyAuthenticated={authenticated} />;
}

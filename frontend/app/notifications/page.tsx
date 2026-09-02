"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiClient, type Persona } from "@/lib/api-client";
import { getStoredPassword } from "@/lib/auth";
import { NotificationsPageView } from "@/components/notifications-page-view";
import { useNotifications } from "@/lib/use-notifications";

export default function NotificationsPage() {
  const router = useRouter();
  const [client] = useState(
    () => new ApiClient(process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080", getStoredPassword),
  );
  const [personas, setPersonas] = useState<Persona[]>([]);
  const { items } = useNotifications();

  useEffect(() => {
    if (!getStoredPassword()) {
      router.push("/login");
      return;
    }
    client.listPersonas().then(setPersonas, () => {});
  }, [client, router]);

  return <NotificationsPageView client={client} items={items} personas={personas} />;
}

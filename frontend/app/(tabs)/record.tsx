import { useRouter } from "expo-router";
import { useEffect } from "react";

export default function RecordTab() {
  const router = useRouter();

  // The Record tab immediately opens the recording setup modal so users
  // always start from a clean, explicit "New session" step.
  useEffect(() => {
    router.replace("/record/setup");
  }, [router]);

  return null;
}

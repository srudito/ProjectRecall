import { AuthCallbackHandler } from "@/src/components/AuthCallbackHandler";

export default function AuthResetCallback() {
  return (
    <AuthCallbackHandler
      destination="/(auth)/reset-password"
      titleKey="oauth.resetCallbackTitle"
    />
  );
}

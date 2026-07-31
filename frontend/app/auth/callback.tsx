import { AuthCallbackHandler } from "@/src/components/AuthCallbackHandler";

export default function AuthCallback() {
  return (
    <AuthCallbackHandler
      destination="/(tabs)/home"
      titleKey="oauth.callbackTitle"
    />
  );
}

import { useLocalSearchParams } from "expo-router";

import { PasswordRecoveryCallbackHandler } from "@/src/components/PasswordRecoveryCallbackHandler";
import {
  buildPasswordRecoveryCallbackUrl,
  type PasswordRecoveryRouteParams,
} from "@/src/services/auth/password-recovery-callback";
import { getAuthRedirectUrl } from "@/src/services/supabase/auth";

export default function AuthResetCallback() {
  const params = useLocalSearchParams<PasswordRecoveryRouteParams>();
  const routeCallbackUrl = buildPasswordRecoveryCallbackUrl(
    getAuthRedirectUrl("auth/reset"),
    params,
  );

  return (
    <PasswordRecoveryCallbackHandler
      routeCallbackUrl={routeCallbackUrl}
    />
  );
}

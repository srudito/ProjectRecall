/** Root-level Expo Router screen names and their authentication policy. */
export const ROOT_ROUTE = {
  index: "index",
  authGroup: "(auth)",
  onboardingGroup: "(onboarding)",
  tabsGroup: "(tabs)",
  recordSetup: "record/setup",
  recordActive: "record/active",
  recordReview: "record/review",
  sessionDetail: "session/[id]",
  projectDetail: "project/[id]",
  authCallback: "auth/callback",
  authLinkCallback: "auth/link-callback",
  authResetCallback: "auth/reset",
} as const;

export const PUBLIC_ROOT_ROUTES = [
  ROOT_ROUTE.index,
  ROOT_ROUTE.authGroup,
  ROOT_ROUTE.authCallback,
  ROOT_ROUTE.authLinkCallback,
  ROOT_ROUTE.authResetCallback,
] as const;

export const AUTHENTICATED_ROOT_ROUTES = [
  ROOT_ROUTE.onboardingGroup,
  ROOT_ROUTE.tabsGroup,
  ROOT_ROUTE.recordSetup,
  ROOT_ROUTE.recordActive,
  ROOT_ROUTE.recordReview,
  ROOT_ROUTE.sessionDetail,
  ROOT_ROUTE.projectDetail,
] as const;

export type RootAuthState =
  | "loading"
  | "authenticated"
  | "unauthenticated";

interface ResolveRootAuthStateInput {
  initialized: boolean;
  hasSession: boolean;
}

/**
 * Do not choose an authenticated or unauthenticated navigator until the
 * persisted Supabase session has finished hydrating from secure storage.
 */
export function resolveRootAuthState({
  initialized,
  hasSession,
}: ResolveRootAuthStateInput): RootAuthState {
  if (!initialized) {
    return "loading";
  }

  return hasSession ? "authenticated" : "unauthenticated";
}

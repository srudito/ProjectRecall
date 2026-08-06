// Centralized product and public branding values.
// Public release contact/legal values are supplied through EXPO_PUBLIC_* EAS
// environment variables. Invalid, missing, credential-bearing, loopback, or
// example-domain destinations are not rendered by the UI.

import { env } from "@/src/config/env";
import {
  isConfiguredPublicUrl,
  isConfiguredSupportEmail,
} from "@/src/config/public-release-values";

export { isConfiguredPublicUrl, isConfiguredSupportEmail };

export const branding = {
  productName: "Project Recall",
  tagline: "Capture every conversation. Remember every detail.",
  supportEmail: env.supportEmail,
  privacyPolicyUrl: env.privacyPolicyUrl,
  termsOfServiceUrl: env.termsOfServiceUrl,
  // Logo/icon references point to bundled assets: swap files, not call sites.
  iconAsset: require("../../assets/images/icon.png"),
  logoAsset: require("../../assets/images/adaptive-icon.png"),
  deepLinkScheme: "projectrecall",
} as const;

export const hasConfiguredSupportEmail = (): boolean =>
  isConfiguredSupportEmail(branding.supportEmail);

export const hasConfiguredPrivacyPolicy = (): boolean =>
  isConfiguredPublicUrl(branding.privacyPolicyUrl);

export const hasConfiguredTermsOfService = (): boolean =>
  isConfiguredPublicUrl(branding.termsOfServiceUrl);

export type Branding = typeof branding;

// Centralized product & branding values.
// Change these here — never scatter them across screens/components.

export const branding = {
  productName: "Project Recall",
  tagline: "Capture every conversation. Remember every detail.",
  supportEmail: "support@example.com",
  privacyPolicyUrl: "https://example.com/privacy",
  termsOfServiceUrl: "https://example.com/terms",
  // Logo / icon references point to bundled assets — swap files, not code.
  iconAsset: require("../../assets/images/icon.png"),
  logoAsset: require("../../assets/images/adaptive-icon.png"),
  deepLinkScheme: "projectrecall",
} as const;

export type Branding = typeof branding;

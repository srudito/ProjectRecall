const unicodeDotPattern = /[\u3002\uff0e\uff61]/;

const normalizeHostname = (hostname: string): string =>
  hostname.trim().toLowerCase();

const hasSpecialUseSuffix = (hostname: string, suffix: string): boolean =>
  hostname === suffix || hostname.endsWith(`.${suffix}`);

const isReservedPublicHostname = (hostname: string): boolean =>
  hostname === "example.com" ||
  hostname.endsWith(".example.com") ||
  hostname === "example.org" ||
  hostname.endsWith(".example.org") ||
  hostname === "example.net" ||
  hostname.endsWith(".example.net") ||
  hasSpecialUseSuffix(hostname, "localhost") ||
  hasSpecialUseSuffix(hostname, "local") ||
  hasSpecialUseSuffix(hostname, "home.arpa") ||
  hasSpecialUseSuffix(hostname, "example") ||
  hasSpecialUseSuffix(hostname, "test") ||
  hasSpecialUseSuffix(hostname, "invalid");

const isValidDomainLabel = (label: string): boolean =>
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);

const isPublicDnsHostname = (hostname: string): boolean => {
  const normalized = normalizeHostname(hostname);
  if (
    !normalized ||
    unicodeDotPattern.test(normalized) ||
    normalized.endsWith(".") ||
    normalized.includes(":")
  ) {
    return false;
  }

  const labels = normalized.split(".");
  const topLevelDomain = labels[labels.length - 1] ?? "";

  return (
    normalized.length <= 253 &&
    labels.length >= 2 &&
    labels.every(isValidDomainLabel) &&
    !/^\d+$/.test(topLevelDomain) &&
    !isReservedPublicHostname(normalized)
  );
};

const getHttpsHostname = (value: string): string | null => {
  const normalized = value.trim();
  if (
    !normalized ||
    /\s/.test(normalized) ||
    normalized.includes("\\") ||
    unicodeDotPattern.test(normalized)
  ) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      !parsed.hostname
    ) {
      return null;
    }

    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
};

export const isConfiguredPublicUrl = (value: string): boolean => {
  const hostname = getHttpsHostname(value);
  return hostname !== null && isPublicDnsHostname(hostname);
};

export const isConfiguredSupportEmail = (value: string): boolean => {
  const normalized = value.trim();
  const match = /^([^@]+)@([^@]+)$/.exec(normalized);
  if (!match || normalized.length > 254) return false;

  const localPart = match[1];
  const rawDomain = match[2];

  if (
    localPart.length === 0 ||
    localPart.length > 64 ||
    !/^[a-z0-9._+-]+$/i.test(localPart) ||
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..") ||
    rawDomain !== rawDomain.trim() ||
    unicodeDotPattern.test(rawDomain)
  ) {
    return false;
  }

  return isPublicDnsHostname(rawDomain);
};

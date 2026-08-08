const systemAlertWindowPermission =
  "android.permission.SYSTEM_ALERT_WINDOW";

const resolveProjectRecallConfig = (config, environment = process.env) => {
  const production =
    environment.EAS_BUILD_PROFILE === "production" ||
    environment.EXPO_PUBLIC_APP_ENV === "production";

  if (!production) {
    return config;
  }

  const blockedPermissions = new Set(
    config.android?.blockedPermissions ?? [],
  );

  blockedPermissions.add(systemAlertWindowPermission);

  return {
    ...config,
    android: {
      ...config.android,
      blockedPermissions: [...blockedPermissions],
    },
  };
};

module.exports = ({ config }) => resolveProjectRecallConfig(config);
module.exports.resolveProjectRecallConfig = resolveProjectRecallConfig;
module.exports.systemAlertWindowPermission = systemAlertWindowPermission;

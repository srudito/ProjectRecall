import NetInfo from "@react-native-community/netinfo";

import { getSupabase } from "@/src/services/supabase/client";
import { resolvePersonalWorkspace } from "@/src/services/workspace/service";
import { storage } from "@/src/utils/storage";

jest.mock("@/src/services/supabase/client", () => ({
  getSupabase: jest.fn(),
}));

jest.mock("@/src/utils/storage", () => ({
  storage: {
    getItem: jest.fn(),
    setItem: jest.fn(async () => true),
  },
}));

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";

const mockedGetSupabase = getSupabase as jest.MockedFunction<
  typeof getSupabase
>;
const mockedNetInfoFetch = NetInfo.fetch as jest.MockedFunction<
  typeof NetInfo.fetch
>;
const mockedStorageGetItem = storage.getItem as jest.Mock;

describe("offline personal workspace resolution", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedStorageGetItem
      .mockResolvedValueOnce(workspaceId)
      .mockResolvedValueOnce("My workspace");
  });

  it("returns the cached workspace without making a cloud request when offline", async () => {
    const from = jest.fn();
    mockedGetSupabase.mockReturnValue({ from } as never);
    mockedNetInfoFetch.mockResolvedValue({
      isConnected: false,
      isInternetReachable: false,
    } as never);

    await expect(resolvePersonalWorkspace(userId)).resolves.toEqual({
      id: workspaceId,
      name: "My workspace",
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("falls back to the cached workspace when the cloud request rejects", async () => {
    const maybeSingle = jest.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const limit = jest.fn(() => ({ maybeSingle }));
    const eqWorkspaceType = jest.fn(() => ({ limit }));
    const eqOwner = jest.fn(() => ({ eq: eqWorkspaceType }));
    const select = jest.fn(() => ({ eq: eqOwner }));
    const from = jest.fn(() => ({ select }));

    mockedGetSupabase.mockReturnValue({ from } as never);
    mockedNetInfoFetch.mockResolvedValue({
      isConnected: true,
      isInternetReachable: null,
    } as never);

    await expect(resolvePersonalWorkspace(userId)).resolves.toEqual({
      id: workspaceId,
      name: "My workspace",
    });
    expect(from).toHaveBeenCalledWith("workspaces");
  });
});

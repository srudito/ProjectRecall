import { create } from "zustand";
import type { Session, User } from "@supabase/supabase-js";

import { getSupabase } from "@/src/services/supabase/client";

interface AuthStoreValue {
  session: Session | null;
  user: User | null;
  initialized: boolean;
  setSession: (s: Session | null) => void;
  initialize: () => Promise<() => void>;
}

export const useAuthStore = create<AuthStoreValue>((set) => ({
  session: null,
  user: null,
  initialized: false,
  setSession: (s) => set({ session: s, user: s?.user ?? null }),
  initialize: async () => {
    const supabase = getSupabase();
    if (!supabase) {
      set({ initialized: true });
      return () => {};
    }
    const { data } = await supabase.auth.getSession();
    set({ session: data.session, user: data.session?.user ?? null, initialized: true });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      set({ session: s, user: s?.user ?? null });
    });
    return () => sub.subscription.unsubscribe();
  },
}));

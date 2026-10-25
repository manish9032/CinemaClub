import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { USE_LOCAL } from '../lib/mode';
import {
  localGetSession,
  localSignUp,
  localSignIn,
  localSignOut,
  type LocalUser,
} from '../lib/localStore';

/** Minimal user shape used across the app (works for both modes) */
export type AppUser = {
  id: string;
  email?: string;
  user_metadata?: { display_name?: string };
};

interface AuthContextType {
  user: AppUser | null;
  session: Session | null;
  loading: boolean;
  signUp: (email: string, password: string, displayName: string) => Promise<{ error?: string }>;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  displayName: string;
  isLocalMode: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function localToAppUser(u: LocalUser): AppUser {
  return {
    id: u.id,
    email: u.email,
    user_metadata: { display_name: u.display_name },
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (USE_LOCAL) {
      const s = localGetSession();
      setUser(s ? localToAppUser(s) : null);
      setSession(null);
      setLoading(false);
      return;
    }

    let mounted = true;

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      setSession(session);
      setUser((session?.user as User) ?? null);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      setSession(session);
      setUser((session?.user as User) ?? null);
      setLoading(false);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const signUp = async (email: string, password: string, displayName: string) => {
    const cleanEmail = email.trim().toLowerCase();
    const cleanName = displayName.trim();

    if (!cleanEmail || !password) {
      return { error: 'Email and password are required.' };
    }
    if (password.length < 6) {
      return { error: 'Password must be at least 6 characters.' };
    }
    if (cleanName.length < 2) {
      return { error: 'Display name must be at least 2 characters.' };
    }

    if (USE_LOCAL) {
      // localSignUp is async (SHA-256) — must await
      const { user: u, error } = await localSignUp(cleanEmail, password, cleanName);
      if (error) return { error };
      if (u) setUser(localToAppUser(u));
      return {};
    }

    const { data, error } = await supabase.auth.signUp({
      email: cleanEmail,
      password,
      options: {
        data: { display_name: cleanName },
      },
    });
    if (error) {
      const msg = error.message || 'Sign up failed';
      if (/already registered|already been registered|user already/i.test(msg)) {
        return { error: 'This email is already registered. Try signing in instead.' };
      }
      return { error: msg };
    }

    if (data.session?.user) {
      setSession(data.session);
      setUser(data.session.user as User);
      return {};
    }

    if (data.user) {
      // Email confirmation may be required; try immediate sign-in when disabled
      const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({
        email: cleanEmail,
        password,
      });
      if (signInData?.session?.user) {
        setSession(signInData.session);
        setUser(signInData.session.user as User);
        return {};
      }
      if (signInErr && /confirm|verification|email not confirmed/i.test(signInErr.message)) {
        return {
          error:
            'Account created. Check your email to confirm, then sign in. (For local testing: Supabase Dashboard → Auth → disable "Confirm email".)',
        };
      }
      return {
        error:
          'Account created. If you are not signed in, check your email for a confirmation link, then sign in.',
      };
    }

    return {};
  };

  const signIn = async (email: string, password: string) => {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !password) {
      return { error: 'Email and password are required.' };
    }

    if (USE_LOCAL) {
      // localSignIn is async — must await
      const { user: u, error } = await localSignIn(cleanEmail, password);
      if (error) return { error };
      if (u) setUser(localToAppUser(u));
      return {};
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email: cleanEmail,
      password,
    });
    if (error) {
      const msg = error.message || 'Sign in failed';
      if (/invalid login|invalid credentials|wrong password/i.test(msg)) {
        return { error: 'Invalid email or password.' };
      }
      if (/email not confirmed|confirm/i.test(msg)) {
        return {
          error:
            'Email not confirmed. Check your inbox, or disable "Confirm email" in Supabase Auth settings for testing.',
        };
      }
      return { error: msg };
    }
    if (data.session?.user) {
      setSession(data.session);
      setUser(data.session.user as User);
    }
    return {};
  };

  const signOut = async () => {
    if (USE_LOCAL) {
      localSignOut();
      setUser(null);
      return;
    }
    await supabase.auth.signOut();
  };

  const displayName =
    (user?.user_metadata?.display_name as string) ||
    user?.email?.split('@')[0] ||
    'User';

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading,
        signUp,
        signIn,
        signOut,
        displayName,
        isLocalMode: USE_LOCAL,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

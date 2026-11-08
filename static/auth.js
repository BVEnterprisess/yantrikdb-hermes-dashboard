const AUTH_SDK_URL = "https://esm.sh/@supabase/supabase-js@2.119.0";

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const bodyText = await response.text();
  let body = {};
  try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { body = { detail: bodyText }; }
  if (!response.ok) throw new Error(body.detail || body.msg || response.statusText);
  return body;
}

async function initializeYantrikDBAuth() {
  const config = await requestJson("/api/auth/config", { headers: {} });
  if (!config.enabled || !config.url || !config.publishable_key) {
    throw new Error("Supabase Auth is not configured for this dashboard.");
  }

  const { createClient } = await import(AUTH_SDK_URL);
  const supabase = createClient(config.url, config.publishable_key, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      flowType: "pkce",
    },
  });

  async function syncSession(session) {
    if (!session?.access_token) {
      await fetch("/api/auth/session", {
        method: "DELETE",
        credentials: "same-origin",
        cache: "no-store",
      });
      return;
    }
    await requestJson("/api/auth/session", {
      method: "POST",
      body: JSON.stringify({
        access_token: session.access_token,
        expires_in: session.expires_in || 3600,
      }),
    });
  }

  supabase.auth.onAuthStateChange((event, session) => {
    if (session) {
      window.setTimeout(() => {
        syncSession(session).catch((error) => console.error("Supabase session sync:", error));
      }, 0);
    } else if (event === "SIGNED_OUT") {
      window.setTimeout(() => {
        syncSession(null).catch((error) => console.error("Supabase sign-out sync:", error));
      }, 0);
    }
  });

  window.yantrikdbAuth = {
    supabase,
    syncSession,
    async signOut() {
      const { error } = await supabase.auth.signOut();
      await syncSession(null);
      if (error) throw error;
    },
  };

  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (data.session) {
    await syncSession(data.session);
    const { data: userData } = await supabase.auth.getUser();
    const label = userData?.user?.email || "";
    const userNode = document.getElementById("authUser");
    if (userNode) userNode.textContent = label;
    if (window.location.pathname === "/login") window.location.replace("/");
  } else if (window.location.pathname === "/login") {
    await syncSession(null);
  }

  const form = document.getElementById("authForm");
  const emailInput = document.getElementById("authEmail");
  const passwordInput = document.getElementById("authPassword");
  const message = document.getElementById("authMessage");
  const signInButton = document.getElementById("signInButton");
  const signUpButton = document.getElementById("signUpButton");

  const showMessage = (text, isError = false) => {
    if (!message) return;
    message.textContent = text;
    message.dataset.state = isError ? "error" : "success";
    message.hidden = !text;
  };

  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      showMessage("");
      signInButton.disabled = true;
      signUpButton.disabled = true;
      try {
        const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
          email: emailInput.value.trim(),
          password: passwordInput.value,
        });
        if (signInError) throw signInError;
        await syncSession(signInData.session);
        window.location.replace("/");
      } catch (signInError) {
        showMessage(signInError.message || "Sign-in failed.", true);
      } finally {
        signInButton.disabled = false;
        signUpButton.disabled = false;
      }
    });

    signUpButton.addEventListener("click", async () => {
      showMessage("");
      signInButton.disabled = true;
      signUpButton.disabled = true;
      try {
        const redirectTo = config.redirect_url || new URL("/login", window.location.origin).toString();
        const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
          email: emailInput.value.trim(),
          password: passwordInput.value,
          options: { emailRedirectTo: redirectTo },
        });
        if (signUpError) throw signUpError;
        if (signUpData.session) {
          await syncSession(signUpData.session);
          window.location.replace("/");
        } else {
          showMessage("Account created. Check your email to confirm the address, then return here to sign in.");
        }
      } catch (signUpError) {
        showMessage(signUpError.message || "Account creation failed.", true);
      } finally {
        signInButton.disabled = false;
        signUpButton.disabled = false;
      }
    });
  }
}

window.yantrikdbAuthReady = initializeYantrikDBAuth();
window.yantrikdbAuthReady
  .then(() => window.dispatchEvent(new Event("yantrikdb-auth-ready")))
  .catch((error) => {
    window.yantrikdbAuthError = error?.message || "Supabase Auth initialization failed.";
    console.error("Supabase Auth initialization:", error);
    const message = document.getElementById("authMessage");
    if (message) {
      message.textContent = window.yantrikdbAuthError;
      message.dataset.state = "error";
      message.hidden = false;
    }
    window.dispatchEvent(new Event("yantrikdb-auth-ready"));
  });

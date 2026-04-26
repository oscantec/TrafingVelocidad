// ═══════════════════════════════════════════════════════════
//  Softrafing Velocidades — Sistema de Autenticación
//  Comparte usuarios con SofTrafing Aforos (mismo proyecto Supabase).
//  Solo entran cuentas con rol 'user' o 'admin' en user_metadata.
//  Soporta 2FA (TOTP): si el usuario tiene 2FA activo, después de la
//  contraseña se pide un código de 6 dígitos.
// ═══════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://lttmesktjiytxykdkbas.supabase.co';
const SUPABASE_KEY = 'sb_publishable_a9FPj59KBSbudTaP_EBhdw_E7MNs6q-';
const ALLOWED_ROLES = ['user', 'admin', 'superadmin'];

let _supabase = null;

function getSupabase() {
  if (_supabase) return _supabase;
  if (typeof window === 'undefined' || !window.supabase) return null;
  _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  return _supabase;
}

function userRole(user) {
  return (user && user.user_metadata && user.user_metadata.role) || '';
}

async function needsMfa(supabase) {
  try {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return !!(aal && aal.nextLevel === 'aal2' && aal.currentLevel === 'aal1');
  } catch {
    return false;
  }
}

/**
 * Verifica que la sesión esté completa: existe, tiene rol válido
 * y, si hay 2FA, está en nivel aal2. Si algo falla, redirige al login.
 */
export async function checkAuth() {
  const supabase = getSupabase();
  if (!supabase) return null;

  const { data: { session } } = await supabase.auth.getSession();
  const isLoginPage = window.location.pathname.includes('login.html');

  if (!session) {
    if (!isLoginPage) {
      sessionStorage.setItem('returnTo', window.location.href);
      window.location.href = window.location.origin + '/login.html';
    }
    return null;
  }

  const role = userRole(session.user);
  if (!ALLOWED_ROLES.includes(role)) {
    await supabase.auth.signOut();
    if (!isLoginPage) window.location.href = window.location.origin + '/login.html';
    return null;
  }

  // Si tiene 2FA pero no completó el segundo paso, no se le considera autenticado
  if (await needsMfa(supabase)) {
    await supabase.auth.signOut();
    if (!isLoginPage) {
      sessionStorage.setItem('returnTo', window.location.href);
      window.location.href = window.location.origin + '/login.html';
    }
    return null;
  }

  if (isLoginPage) {
    window.location.href = window.location.origin + '/index.html';
  }
  return session;
}

/**
 * Paso 1 del login: correo + contraseña.
 * Devuelve { mfaRequired: true, factorId, challengeId } si toca pedir
 * el código de 2FA, o { mfaRequired: false } si el login está completo.
 */
export async function login(email, password) {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Cliente Supabase no cargado');

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;

  const role = userRole(data.user);
  if (!ALLOWED_ROLES.includes(role)) {
    await supabase.auth.signOut();
    const e = new Error('Tu cuenta no tiene rol autorizado para esta aplicación.');
    e.code = 'no_role';
    throw e;
  }

  if (await needsMfa(supabase)) {
    const { data: factorsData, error: lfErr } = await supabase.auth.mfa.listFactors();
    if (lfErr) throw lfErr;
    const verified = (factorsData?.totp || []).find(f => f.status === 'verified');
    if (verified) {
      const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId: verified.id });
      if (chErr) throw chErr;
      return { mfaRequired: true, factorId: verified.id, challengeId: ch.id };
    }
  }

  return { mfaRequired: false };
}

/**
 * Paso 2 del login: verifica el código TOTP de 6 dígitos.
 */
export async function verifyMfa(factorId, challengeId, code) {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Cliente Supabase no cargado');
  const { error } = await supabase.auth.mfa.verify({ factorId, challengeId, code });
  if (error) throw error;
}

/**
 * Cierra la sesión activa.
 */
export async function logout() {
  const supabase = getSupabase();
  if (!supabase) return;
  await supabase.auth.signOut();
  window.location.href = window.location.origin + '/login.html';
}

// Auto-check al cargar (excepto en login.html, que lo llama manualmente)
if (typeof window !== 'undefined' && !window.location.pathname.includes('login.html')) {
  if (window.supabase) {
    checkAuth();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      if (window.supabase) checkAuth();
    });
  }
}

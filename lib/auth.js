// ═══════════════════════════════════════════════════════════
//  Softrafing Velocidades — Sistema de Autenticación
// ═══════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://lttmesktjiytxykdkbas.supabase.co';
const SUPABASE_KEY = 'sb_publishable_a9FPj59KBSbudTaP_EBhdw_E7MNs6q-';

let _supabase = null;

function getSupabase() {
  if (_supabase) return _supabase;
  if (typeof window === 'undefined' || !window.supabase) return null;
  _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  return _supabase;
}

/**
 * Verifica si hay una sesión activa.
 * Si no la hay y la página requiere auth, redirige al login.
 */
export async function checkAuth() {
  const supabase = getSupabase();
  if (!supabase) return;

  const { data: { session } } = await supabase.auth.getSession();
  
  const isLoginPage = window.location.pathname.includes('login.html');
  
  if (!session && !isLoginPage) {
    // Guardar la página actual para volver después del login
    sessionStorage.setItem('returnTo', window.location.href);
    window.location.href = window.location.origin + '/login.html';
  } else if (session && isLoginPage) {
    // Si ya está logueado y está en el login, ir al inicio
    window.location.href = window.location.origin + '/index.html';
  }
  
  return session;
}

/**
 * Inicia sesión con correo y contraseña.
 */
export async function login(email, password) {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Cliente Supabase no cargado');

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) throw error;
  return data;
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

// Ejecutar check automático al cargar si es un módulo (no para el login que lo llama manual)
if (typeof window !== 'undefined' && !window.location.pathname.includes('login.html')) {
  // Esperar a que el SDK de Supabase esté listo si se carga por CDN
  if (window.supabase) {
    checkAuth();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      if (window.supabase) checkAuth();
    });
  }
}

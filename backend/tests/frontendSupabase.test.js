import test from 'node:test';
import assert from 'node:assert/strict';

test('frontend Supabase client gracefully disables itself without Vite env values', async () => {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  delete process.env.VITE_SUPABASE_URL;
  delete process.env.VITE_SUPABASE_ANON_KEY;

  try {
    const importUrl = new URL('../../frontend/src/supabaseClient.js', import.meta.url).href + `?t=${Date.now()}`;
    const mod = await import(importUrl);

    assert.equal(mod.supabase, null);
    assert.equal(mod.hasSupabase, false);
  } finally {
    if (supabaseUrl === undefined) delete process.env.VITE_SUPABASE_URL;
    else process.env.VITE_SUPABASE_URL = supabaseUrl;
    if (supabaseAnonKey === undefined) delete process.env.VITE_SUPABASE_ANON_KEY;
    else process.env.VITE_SUPABASE_ANON_KEY = supabaseAnonKey;
  }
});

import { createClient } from '@supabase/supabase-js';

const env = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : process.env;

const supabaseUrl = env?.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = env?.VITE_SUPABASE_ANON_KEY?.trim();

export const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;
export const hasSupabase = Boolean(supabase);

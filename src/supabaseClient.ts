import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Supabase URL and publishable/anon key are required in .env. Add VITE_SUPABASE_PUBLISHABLE_KEY for new Supabase projects.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseKey);

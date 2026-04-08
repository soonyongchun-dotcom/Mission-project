const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');

dotenv.config();

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(url, key);

(async () => {
  console.log('URL', url);
  console.log('Key exists', !!key);
  const r = await supabase.storage.listBuckets();
  console.log('listBuckets', r);
  const c = await supabase.storage.from('mission-files').list('');
  console.log('mission-files list', c);
})();

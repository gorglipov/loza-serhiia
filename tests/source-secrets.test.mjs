import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

test('tracked sources contain no credential literals or private keys',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const files=execFileSync(process.env.LOZA_GIT || 'git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
  const patterns=[/cfat_[A-Za-z0-9_-]{30,}/,/gh[pousr]_[A-Za-z0-9]{30,}/,/github_pat_[A-Za-z0-9_]{30,}/,/\b\d{6,15}:[A-Za-z0-9_-]{25,}\b/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
  const assignments=/(?:MONO_TOKEN|MONO_WEBHOOK_KEY|TELEGRAM_BOT_TOKEN|ADMIN_CSRF_SECRET|CHECKOUT_SECURITY_KEY)\s*[:=]\s*['"]([^'"\r\n]+)['"]/g;
  for(const file of files){
    if(/(?:^|\/)(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?)$/.test(file) && !file.endsWith('.example'))assert.fail('Tracked secret file: '+file);
    if(!/\.(?:js|mjs|cjs|json|html|css|md|toml|sql|ya?ml)$/.test(file))continue;
    const text=await readFile(new URL(file,new URL('../',import.meta.url)),'utf8');
    for(const pattern of patterns)assert.ok(!pattern.test(text),'Potential credential in '+file);
    for(const match of text.matchAll(assignments)){
      assert.ok(file.startsWith('tests/') && (/fixture|test/.test(match[1]) || match[1].trim()===''),'Credential assignment in '+file);
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair,exportJWK,createLocalJWKSet,SignJWT } from 'jose';
import { verifyGoogleToken } from '../src/server/google.ts';
test('OIDC verifies signature, issuer, audience, expiry, nonce and verified email',async()=>{
  const keys=await generateKeyPair('RS256'),jwk=await exportJWK(keys.publicKey);jwk.kid='synthetic';
  const resolver=createLocalJWKSet({keys:[jwk]});
  const token=(extra:Record<string,unknown>={})=>new SignJWT({nonce:'nonce',email:'SYNTHETIC@example.invalid',email_verified:true,...extra})
    .setProtectedHeader({alg:'RS256',kid:'synthetic'}).setIssuer('https://accounts.google.com').setAudience('synthetic-client').setSubject('synthetic-subject').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  assert.deepEqual(await verifyGoogleToken(await token(),'nonce','synthetic-client',resolver),{provider:'google',issuer:'https://accounts.google.com',subject:'synthetic-subject',email:'synthetic@example.invalid'});
  const multiAudience=await new SignJWT({nonce:'nonce',email:'synthetic@example.invalid',email_verified:true}).setProtectedHeader({alg:'RS256',kid:'synthetic'})
    .setIssuer('https://accounts.google.com').setAudience(['synthetic-client','other']).setSubject('synthetic').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  await assert.rejects(verifyGoogleToken(multiAudience,'nonce','synthetic-client',resolver),{code:'UNAUTHENTICATED'});
  for(const [jwt,nonce,aud] of [[await token(),'wrong','synthetic-client'],[await token(),'nonce','wrong'],[await token({email_verified:false}),'nonce','synthetic-client'],[await token({azp:'other'}),'nonce','synthetic-client']] as string[][])
    await assert.rejects(verifyGoogleToken(jwt,nonce,aud,resolver),{code:'UNAUTHENTICATED'});
  for(const change of ['expiry','issuer','signature']){
    const privateKey=change==='signature'?(await generateKeyPair('RS256')).privateKey:keys.privateKey;
    const jwt=await new SignJWT({nonce:'nonce',email:'synthetic@example.invalid',email_verified:true}).setProtectedHeader({alg:'RS256',kid:'synthetic'})
      .setIssuer(change==='issuer'?'https://attacker.invalid':'https://accounts.google.com').setAudience('synthetic-client').setSubject('synthetic').setIssuedAt().setExpirationTime(change==='expiry'?'0s':'5m').sign(privateKey);
    if(change==='expiry') { const expired=await new SignJWT({nonce:'nonce',email:'synthetic@example.invalid',email_verified:true}).setProtectedHeader({alg:'RS256',kid:'synthetic'}).setIssuer('https://accounts.google.com').setAudience('synthetic-client').setSubject('synthetic').setIssuedAt(Math.floor(Date.now()/1000)-600).setExpirationTime(Math.floor(Date.now()/1000)-300).sign(privateKey);await assert.rejects(verifyGoogleToken(expired,'nonce','synthetic-client',resolver),{code:'UNAUTHENTICATED'}); }
    else await assert.rejects(verifyGoogleToken(jwt,'nonce','synthetic-client',resolver),{code:'UNAUTHENTICATED'});
  }
});

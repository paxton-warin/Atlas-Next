import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedLocalActorAuthority, checkedLocalBindingAuthority, assertLocalBindingAuthority,
  revokeLocalAuthority} from '../runtime/local-authority.ts';
const actor = {version:2,profileId:'11111111-1111-4111-8111-111111111111',replicaId:'22222222-2222-4222-8222-222222222222',
  localAuthGeneration:'generation_0123456789abcdef',browserSessionId:'session_0123456789abcdef'};
test('local authority is fixed to profile, replica, generation, session, document and logical origin, not cloud time', () => {
  const checked = checkedLocalActorAuthority(actor), doc='document_0123456789abcdef';
  const binding=checkedLocalBindingAuthority({...checked,documentId:doc,logicalOrigin:'https://site.example'},checked,doc,'https://site.example/path');
  assert.doesNotThrow(()=>assertLocalBindingAuthority(binding,checked));
  for(const changed of [{...checked,profileId:checked.replicaId},{...checked,replicaId:checked.profileId},
    {...checked,localAuthGeneration:'next_generation_0123456789'},{...checked,browserSessionId:'other_session_0123456789'},null])
    assert.throws(()=>assertLocalBindingAuthority(binding,changed),{name:'SecurityError'});
  assert.throws(()=>checkedLocalBindingAuthority({...binding,logicalOrigin:'https://other.example'},checked,doc,'https://site.example'),{name:'SecurityError'});
  assert.throws(()=>checkedLocalActorAuthority({...actor,replicaId:actor.profileId}),{name:'SecurityError'});
  assert.equal(Object.isFrozen(checked),true); assert.equal(Object.hasOwn(checked,'expiresAt'),false);
});
test('delayed cleanup cannot revoke a newer local account generation', () => {
  const checked=checkedLocalActorAuthority(actor),next=checkedLocalActorAuthority({...actor,localAuthGeneration:'next_generation_0123456789'});
  assert.equal(revokeLocalAuthority(checked,checked.localAuthGeneration),null);
  assert.equal(revokeLocalAuthority(next,checked.localAuthGeneration),next);
});

import { parseXaiModelList, expandModelSelectableIds } from '../lib/grok-client';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const sample = {
  models: [
    { id: 'grok-3', aliases: ['grok-latest'], input_modalities: ['text'], output_modalities: ['text'] },
    { id: 'grok-imagine-image', aliases: [], output_modalities: ['image'] },
  ],
};

const parsed = parseXaiModelList(sample);
assert(parsed.length === 2, 'expected 2 parsed models');
assert(parsed[0].id === 'grok-3', 'first model id');

const expanded = expandModelSelectableIds(parsed);
assert(expanded.some(m => m.id === 'grok-latest'), 'alias should be selectable');
assert(expanded.some(m => m.id === 'grok-3'), 'primary id should remain');

console.log('verify-models: OK', expanded.map(m => m.id).join(', '));
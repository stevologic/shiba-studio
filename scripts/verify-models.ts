import assert from 'node:assert/strict';
import { parseXaiModelList, expandModelSelectableIds } from '../lib/grok-client';
import {
  CHEAP_CLOUD_MODEL_REF,
  DEFAULT_CLOUD_MODEL_ID,
  DEFAULT_CLOUD_MODEL_REF,
  FALLBACK_CLOUD_GROK_MODELS,
  contextWindowTokensForModel,
  isLegacyPlaceholderModel,
  modelPreferenceScore,
  pickPreferredCloudModel,
  replayBudgetForModel,
  resolveDefaultCloudModel,
} from '../lib/model-providers';
import { estimateTokenCost, getModelPricing } from '../lib/usage';

function main() {
  const sample = {
    models: [
      { id: 'grok-3', aliases: ['grok-latest'], input_modalities: ['text'], output_modalities: ['text'] },
      { id: 'grok-imagine-image', aliases: [], output_modalities: ['image'] },
    ],
  };

  const parsed = parseXaiModelList(sample);
  assert.equal(parsed.length, 2, 'expected 2 parsed models');
  assert.equal(parsed[0].id, 'grok-3', 'first model id');

  const expanded = expandModelSelectableIds(parsed);
  assert(expanded.some((m) => m.id === 'grok-latest'), 'alias should be selectable');
  assert(expanded.some((m) => m.id === 'grok-3'), 'primary id should remain');

  assert.equal(DEFAULT_CLOUD_MODEL_ID, 'grok-4.6');
  assert.equal(DEFAULT_CLOUD_MODEL_REF, 'cloud:grok-4.6');
  assert.equal(resolveDefaultCloudModel(''), DEFAULT_CLOUD_MODEL_REF);
  assert.equal(resolveDefaultCloudModel('cloud:grok-4.3-latest'), 'cloud:grok-4.3-latest');
  assert.equal(isLegacyPlaceholderModel('cloud:grok-4'), true);
  assert.equal(isLegacyPlaceholderModel('cloud:grok-4.6'), false);
  assert.equal(isLegacyPlaceholderModel('cloud:grok-4.3-latest'), false);

  const catalog = [
    { id: 'cloud:grok-4' },
    { id: 'cloud:grok-4.3-latest' },
    { id: 'cloud:grok-4.6' },
    { id: CHEAP_CLOUD_MODEL_REF },
  ];
  assert.equal(
    pickPreferredCloudModel(catalog, 'cloud:grok-4'),
    'cloud:grok-4.6',
    'legacy grok-4 placeholder must not beat the flagship',
  );
  assert.equal(
    pickPreferredCloudModel(catalog, 'cloud:grok-4.3-latest'),
    'cloud:grok-4.3-latest',
    'an explicit saved non-legacy model is kept',
  );
  assert.equal(pickPreferredCloudModel(catalog), 'cloud:grok-4.6');
  assert(
    modelPreferenceScore('cloud:grok-4.6') > modelPreferenceScore('cloud:grok-4.3-latest'),
    '4.6 outranks 4.3',
  );
  assert(
    modelPreferenceScore('cloud:grok-4.6') > modelPreferenceScore(CHEAP_CLOUD_MODEL_REF),
    'flagship outranks the cheap coding model',
  );

  assert.equal(FALLBACK_CLOUD_GROK_MODELS[0].id, DEFAULT_CLOUD_MODEL_REF);
  assert(FALLBACK_CLOUD_GROK_MODELS.some((model) => model.id === 'cloud:grok-4'));

  assert.equal(contextWindowTokensForModel('cloud:grok-4.6'), 500_000);
  assert.equal(contextWindowTokensForModel('cloud:grok-4.3-latest'), 1_000_000);
  assert.equal(replayBudgetForModel('cloud:grok-4.6'), 40_000);
  assert.equal(replayBudgetForModel('cloud:grok-4'), 20_480);
  assert(replayBudgetForModel('cloud:grok-4.6') > replayBudgetForModel('cloud:grok-4'));

  const pricing46 = getModelPricing('cloud:grok-4.6');
  assert.equal(pricing46.inputPer1M, 2);
  assert.equal(pricing46.outputPer1M, 6);
  const pricing43 = getModelPricing('grok-4.3-latest');
  assert.equal(pricing43.inputPer1M, 1.25);
  assert.equal(pricing43.outputPer1M, 2.5);

  const short = estimateTokenCost('grok-4.6', 1_000_000, 0);
  const long = estimateTokenCost('grok-4.6', 200_000, 0);
  const shortRate = estimateTokenCost('grok-4.6', 100_000, 0);
  assert.equal(shortRate, 0.2);
  assert.equal(long, 0.8);
  assert.equal(short, 4);
  assert.equal(estimateTokenCost('grok-4.3', 200_000, 0), 0.5);

  console.log('verify-models: OK', expanded.map((m) => m.id).join(', '));
}

main();

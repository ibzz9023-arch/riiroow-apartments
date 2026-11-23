import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WHATSAPP_TEMPLATE,
  formatWhatsAppTemplate,
} from '../src/whatsappMessageTemplates.js';

test('formats all supported maintenance message placeholders', () => {
  const message = formatWhatsAppTemplate(
    'Request {request}; file {attachment}; link {url}',
    { request: 'Unit 102 leak', attachment: 'photo.jpg', url: 'https://example.test/evidence' },
  );

  assert.equal(
    message,
    'Request Unit 102 leak; file photo.jpg; link https://example.test/evidence',
  );
});

test('replaces repeated placeholders and preserves line breaks', () => {
  const message = formatWhatsAppTemplate(
    '{request}\n{request}\n{attachment}',
    { request: 'Unit 101', attachment: 'video.mp4' },
  );

  assert.equal(message, 'Unit 101\nUnit 101\nvideo.mp4');
});

test('uses the safe default template when the saved template is blank', () => {
  assert.equal(formatWhatsAppTemplate('   ', { request: 'Unit 101' }), DEFAULT_WHATSAPP_TEMPLATE
    .replace('{request}', 'Unit 101')
    .replace('{attachment}', '')
    .replace('{url}', ''));
});

test('leaves unsupported placeholders unchanged', () => {
  assert.equal(
    formatWhatsAppTemplate('Request {request}; unknown {tenant}', { request: 'Unit 103' }),
    'Request Unit 103; unknown {tenant}',
  );
});

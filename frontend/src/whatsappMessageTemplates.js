export const DEFAULT_WHATSAPP_TEMPLATE = [
  'Hello,',
  'Maintenance request: {request}',
  'Attachment: {attachment}',
  'Secure link (expires in 10 minutes): {url}',
  '',
  'Please review the attached evidence.',
].join('\n');

export const WHATSAPP_TEMPLATE_STORAGE_KEY = 'riiroow.whatsapp.maintenance-template.v1';

const TEMPLATE_PLACEHOLDERS = /\\{(request|attachment|url)\\}/g;

export const formatWhatsAppTemplate = (template, values = {}) => {
  const source = typeof template === 'string' && template.trim()
    ? template
    : DEFAULT_WHATSAPP_TEMPLATE;

  return source.replace(TEMPLATE_PLACEHOLDERS, (_match, key) => String(values[key] ?? ''));
};

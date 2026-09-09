import { useState, type FormEvent } from 'react';
import { submitGeneralInquiry } from '../api/inquiries';
import { ApiError } from '../api/client';
import {
  INQUIRY_EMAIL_MAX,
  INQUIRY_MESSAGE_MAX,
  INQUIRY_MOBILE_MAX,
  INQUIRY_NAME_MAX,
  type InquiryType,
} from '../types/inquiry';

interface FieldErrors {
  name?: string;
  mobile?: string;
  email?: string;
  type?: string;
  message?: string;
}

// Same "reasonable, not RFC-5322" shape check as PropertyInquiryForm
// (Phase 45C) — duplicated rather than imported/shared, deliberately: a
// shared helper would mean touching that already-shipped component for
// this phase, which the brief explicitly asks not to change.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Phase 45D — Contact Us / general inquiry. Inline section, not a
 * modal: the existing ContactCTA design was already a plain page
 * section (no overlay/dialog), so this keeps that shape rather than
 * introducing modal behavior the brief says not to add unnecessarily.
 * No real phone/email/WhatsApp/address exists anywhere in this project
 * (Phase 43A discovery) — none is invented here either; this section's
 * job is entirely the inquiry form now, not a contact-details display.
 *
 * property_id is never sent — this form has no propertyId prop, no
 * propertyId state, and calls submitGeneralInquiry() (api/inquiries.ts),
 * which has no propertyId parameter at all. The visitor's own BUYER/
 * SELLER choice, not a hardcoded value, is required before submit.
 *
 * Phase 46B: heading/copy updated per the approved design and the
 * BUYER/SELLER radios restyled as card-style options (CSS `:has()`
 * driven off the native input's checked state — see global.css) —
 * validation, submit handling, and the API payload below are untouched.
 */
export default function ContactCTA() {
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [type, setType] = useState<InquiryType | ''>('');
  const [message, setMessage] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};

    const trimmedName = name.trim();
    if (!trimmedName) {
      errors.name = 'Please enter your name.';
    } else if (trimmedName.length > INQUIRY_NAME_MAX) {
      errors.name = `Name must be ${INQUIRY_NAME_MAX} characters or fewer.`;
    }

    const trimmedMobile = mobile.trim();
    if (!trimmedMobile) {
      errors.mobile = 'Please enter your mobile number.';
    } else if (trimmedMobile.length > INQUIRY_MOBILE_MAX) {
      errors.mobile = `Mobile number must be ${INQUIRY_MOBILE_MAX} characters or fewer.`;
    }

    const trimmedEmail = email.trim();
    if (trimmedEmail) {
      if (trimmedEmail.length > INQUIRY_EMAIL_MAX) {
        errors.email = `Email must be ${INQUIRY_EMAIL_MAX} characters or fewer.`;
      } else if (!EMAIL_PATTERN.test(trimmedEmail)) {
        errors.email = 'Please enter a valid email address.';
      }
    }

    if (type !== 'BUYER' && type !== 'SELLER') {
      errors.type = "Please choose whether you're looking to buy or sell.";
    }

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      errors.message = 'Please enter a short message.';
    } else if (trimmedMessage.length > INQUIRY_MESSAGE_MAX) {
      errors.message = `Message must be ${INQUIRY_MESSAGE_MAX} characters or fewer.`;
    }

    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || successMessage) return; // guards against double-submit / resubmitting after success

    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0 || (type !== 'BUYER' && type !== 'SELLER')) return;

    setSubmitting(true);
    setSubmitError(null);

    try {
      const trimmedEmail = email.trim();
      const result = await submitGeneralInquiry({
        name: name.trim(),
        mobile: mobile.trim(),
        email: trimmedEmail || undefined,
        type,
        message: message.trim(),
      });
      setSuccessMessage(result.message);
    } catch (err) {
      // Entered values are deliberately left as-is on failure (no reset)
      // so the visitor can correct/retry without re-typing everything.
      setSubmitError(describeSubmitError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section id="contact" className="contact-cta" aria-label="Contact Aryan Landmark">
      {successMessage ? (
        <div className="inquiry-form__success" role="status">
          <h2>Thank you!</h2>
          <p>{successMessage}</p>
        </div>
      ) : (
        <>
          <div className="section-heading">
            <h2>Let&rsquo;s Talk About Your Property Requirements</h2>
            <p>Whether you&rsquo;re looking to buy or sell, tell us what you&rsquo;re looking for.</p>
          </div>

          <form className="contact-form" onSubmit={handleSubmit} noValidate>
            <div className="form-row">
              <div className="form-field">
                <label htmlFor="contact-name">
                  Full name <span className="form-field__required">*</span>
                </label>
                <input
                  id="contact-name"
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={submitting}
                  maxLength={INQUIRY_NAME_MAX}
                  aria-invalid={Boolean(fieldErrors.name)}
                  aria-describedby={fieldErrors.name ? 'contact-name-error' : undefined}
                />
                {fieldErrors.name && (
                  <p className="form-field__error" id="contact-name-error" role="alert">
                    {fieldErrors.name}
                  </p>
                )}
              </div>

              <div className="form-field">
                <label htmlFor="contact-mobile">
                  Mobile number <span className="form-field__required">*</span>
                </label>
                <input
                  id="contact-mobile"
                  type="tel"
                  value={mobile}
                  onChange={(event) => setMobile(event.target.value)}
                  disabled={submitting}
                  maxLength={INQUIRY_MOBILE_MAX}
                  aria-invalid={Boolean(fieldErrors.mobile)}
                  aria-describedby={fieldErrors.mobile ? 'contact-mobile-error' : undefined}
                />
                {fieldErrors.mobile && (
                  <p className="form-field__error" id="contact-mobile-error" role="alert">
                    {fieldErrors.mobile}
                  </p>
                )}
              </div>
            </div>

            <div className="form-field">
              <label htmlFor="contact-email">Email (optional)</label>
              <input
                id="contact-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={submitting}
                maxLength={INQUIRY_EMAIL_MAX}
                aria-invalid={Boolean(fieldErrors.email)}
                aria-describedby={fieldErrors.email ? 'contact-email-error' : undefined}
              />
              {fieldErrors.email && (
                <p className="form-field__error" id="contact-email-error" role="alert">
                  {fieldErrors.email}
                </p>
              )}
            </div>

            <fieldset
              className="form-field radio-group"
              aria-invalid={Boolean(fieldErrors.type)}
              aria-describedby={fieldErrors.type ? 'contact-type-error' : undefined}
            >
              <legend>
                I am&hellip; <span className="form-field__required">*</span>
              </legend>
              <div className="radio-group__options">
                <label className="radio-group__option">
                  <input
                    type="radio"
                    name="contact-inquiry-type"
                    value="BUYER"
                    checked={type === 'BUYER'}
                    onChange={() => setType('BUYER')}
                    disabled={submitting}
                  />
                  Looking to buy
                </label>
                <label className="radio-group__option">
                  <input
                    type="radio"
                    name="contact-inquiry-type"
                    value="SELLER"
                    checked={type === 'SELLER'}
                    onChange={() => setType('SELLER')}
                    disabled={submitting}
                  />
                  Looking to sell
                </label>
              </div>
              {fieldErrors.type && (
                <p className="form-field__error" id="contact-type-error" role="alert">
                  {fieldErrors.type}
                </p>
              )}
            </fieldset>

            <div className="form-field">
              <label htmlFor="contact-message">
                Message <span className="form-field__required">*</span>
              </label>
              <textarea
                id="contact-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                disabled={submitting}
                maxLength={INQUIRY_MESSAGE_MAX}
                rows={4}
                aria-invalid={Boolean(fieldErrors.message)}
                aria-describedby={fieldErrors.message ? 'contact-message-error' : undefined}
              />
              {fieldErrors.message && (
                <p className="form-field__error" id="contact-message-error" role="alert">
                  {fieldErrors.message}
                </p>
              )}
            </div>

            {submitError && (
              <p className="state-message state-message--error" role="alert">
                {submitError}
              </p>
            )}

            <button type="submit" className="button button--primary" disabled={submitting}>
              {submitting ? 'Sending…' : 'Send Enquiry'}
            </button>
          </form>
        </>
      )}
    </section>
  );
}

function describeSubmitError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      return 'Too many requests. Please wait a moment and try again.';
    }
    if (err.status === 400) {
      return err.message;
    }
    return 'Something went wrong while submitting your inquiry. Please try again.';
  }
  return 'Something went wrong while submitting your inquiry. Please try again.';
}

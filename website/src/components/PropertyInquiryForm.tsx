import { useEffect, useRef, useState, type FormEvent } from 'react';
import { submitPropertyInquiry } from '../api/inquiries';
import { ApiError } from '../api/client';
import {
  INQUIRY_EMAIL_MAX,
  INQUIRY_MESSAGE_MAX,
  INQUIRY_MOBILE_MAX,
  INQUIRY_NAME_MAX,
} from '../types/inquiry';

interface PropertyInquiryFormProps {
  propertyId: string;
  propertyCode: string;
  propertyType: string;
  category: string;
  location: string | null;
  onClose: () => void;
}

interface FieldErrors {
  name?: string;
  mobile?: string;
  email?: string;
  message?: string;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])';

// Simple, "reasonable" email shape check — deliberately not the full
// RFC-5322 grammar the backend's `validator` package enforces server-
// side; the server is the real authority, this only catches obvious
// typos before a round trip.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * "I'm Interested" — nested inside PropertyDetail's own modal (Phase
 * 43A/43C's approved approach continued: no route, no react-router, no
 * form library). Same hand-written dialog pattern as PropertyDetail
 * (focus trap, Escape, body-scroll-lock) plus focus restoration on
 * close, since this is a modal opened *from* another modal rather than
 * from a page-level trigger.
 *
 * Always submits a BUYER inquiry for `propertyId` — `type` is never
 * part of this form's state or its request body at all (see
 * api/inquiries.ts / types/inquiry.ts), so there is no code path by
 * which this form could send one.
 */
export default function PropertyInquiryForm({
  propertyId,
  propertyCode,
  propertyType,
  category,
  location,
  onClose,
}: PropertyInquiryFormProps) {
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;

      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocusedRef.current?.focus();
    };
  }, [onClose]);

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
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    setSubmitError(null);

    try {
      const trimmedEmail = email.trim();
      const result = await submitPropertyInquiry(propertyId, {
        name: name.trim(),
        mobile: mobile.trim(),
        email: trimmedEmail || undefined,
        message: message.trim(),
      });
      setSuccessMessage(result.message);
    } catch (err) {
      setSubmitError(describeSubmitError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="modal-overlay modal-overlay--nested"
      onClick={(event) => {
        // This overlay is rendered as a DOM child of PropertyDetail's
        // own clickable backdrop (see PropertyDetail.tsx) — without
        // stopping propagation here, a click on *this* backdrop would
        // bubble up and close PropertyDetail too, not just this form.
        event.stopPropagation();
        if (!submitting) onClose();
      }}
    >
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inquiry-form-title"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="modal-close"
          onClick={onClose}
          aria-label="Close inquiry form"
          disabled={submitting}
        >
          &times;
        </button>

        {successMessage ? (
          <div className="inquiry-form__success" role="status">
            <h2 id="inquiry-form-title">Thank you!</h2>
            <p>{successMessage}</p>
            <button type="button" className="button button--primary" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <>
            <h2 id="inquiry-form-title">I&rsquo;m Interested in this Property</h2>
            <p className="inquiry-form__context">
              {propertyType} &middot; {category} &middot; {propertyCode}
              {location ? ` — ${location}` : ''}
            </p>

            <form onSubmit={handleSubmit} noValidate>
              <div className="form-row">
                <div className="form-field">
                  <label htmlFor="inquiry-name">
                    Full name <span className="form-field__required">*</span>
                  </label>
                  <input
                    id="inquiry-name"
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={submitting}
                    maxLength={INQUIRY_NAME_MAX}
                    aria-invalid={Boolean(fieldErrors.name)}
                    aria-describedby={fieldErrors.name ? 'inquiry-name-error' : undefined}
                  />
                  {fieldErrors.name && (
                    <p className="form-field__error" id="inquiry-name-error" role="alert">
                      {fieldErrors.name}
                    </p>
                  )}
                </div>

                <div className="form-field">
                  <label htmlFor="inquiry-mobile">
                    Mobile number <span className="form-field__required">*</span>
                  </label>
                  <input
                    id="inquiry-mobile"
                    type="tel"
                    value={mobile}
                    onChange={(event) => setMobile(event.target.value)}
                    disabled={submitting}
                    maxLength={INQUIRY_MOBILE_MAX}
                    aria-invalid={Boolean(fieldErrors.mobile)}
                    aria-describedby={fieldErrors.mobile ? 'inquiry-mobile-error' : undefined}
                  />
                  {fieldErrors.mobile && (
                    <p className="form-field__error" id="inquiry-mobile-error" role="alert">
                      {fieldErrors.mobile}
                    </p>
                  )}
                </div>
              </div>

              <div className="form-field">
                <label htmlFor="inquiry-email">Email (optional)</label>
                <input
                  id="inquiry-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={submitting}
                  maxLength={INQUIRY_EMAIL_MAX}
                  aria-invalid={Boolean(fieldErrors.email)}
                  aria-describedby={fieldErrors.email ? 'inquiry-email-error' : undefined}
                />
                {fieldErrors.email && (
                  <p className="form-field__error" id="inquiry-email-error" role="alert">
                    {fieldErrors.email}
                  </p>
                )}
              </div>

              <div className="form-field">
                <label htmlFor="inquiry-message">
                  Message <span className="form-field__required">*</span>
                </label>
                <textarea
                  id="inquiry-message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  disabled={submitting}
                  maxLength={INQUIRY_MESSAGE_MAX}
                  rows={4}
                  aria-invalid={Boolean(fieldErrors.message)}
                  aria-describedby={fieldErrors.message ? 'inquiry-message-error' : undefined}
                />
                {fieldErrors.message && (
                  <p className="form-field__error" id="inquiry-message-error" role="alert">
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
      </div>
    </div>
  );
}

function describeSubmitError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      return 'You have submitted a few requests recently. Please wait a minute and try again.';
    }
    if (err.status === 404) {
      return 'This property is no longer available for enquiries.';
    }
    if (err.status === 400) {
      return err.message;
    }
    return 'Something went wrong while submitting your inquiry. Please try again.';
  }
  return 'Something went wrong while submitting your inquiry. Please try again.';
}

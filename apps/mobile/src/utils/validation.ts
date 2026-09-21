// Phase 5 — form validation.
// Client-side checks mirror the API contracts (services/api schemas):
// email format (max 254), password min 12 chars (registration policy),
// displayName 1–100 chars. Server remains the authority; these exist to
// fail fast with friendly messages before a network round-trip.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(email: string): string | null {
  const value = email.trim();
  if (value.length === 0) {
    return 'Email is required.';
  }
  if (value.length > 254) {
    return 'Email is too long.';
  }
  if (!EMAIL_PATTERN.test(value)) {
    return 'Enter a valid email address.';
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length === 0) {
    return 'Password is required.';
  }
  if (password.length < 12) {
    return 'Password must be at least 12 characters.';
  }
  if (password.length > 128) {
    return 'Password must be at most 128 characters.';
  }
  return null;
}

/** Login accepts any non-empty password (policy enforced at registration). */
export function validateLoginPassword(password: string): string | null {
  if (password.length === 0) {
    return 'Password is required.';
  }
  return null;
}

export function validateDisplayName(displayName: string): string | null {
  const value = displayName.trim();
  if (value.length === 0) {
    return 'Display name is required.';
  }
  if (value.length > 100) {
    return 'Display name must be at most 100 characters.';
  }
  return null;
}

export interface LoginFormErrors {
  email?: string;
  password?: string;
}

export function validateLoginForm(email: string, password: string): LoginFormErrors {
  const errors: LoginFormErrors = {};
  const emailError = validateEmail(email);
  if (emailError) {
    errors.email = emailError;
  }
  const passwordError = validateLoginPassword(password);
  if (passwordError) {
    errors.password = passwordError;
  }
  return errors;
}

export interface RegisterFormErrors extends LoginFormErrors {
  displayName?: string;
}

export function validateRegisterForm(
  displayName: string,
  email: string,
  password: string,
): RegisterFormErrors {
  const errors: RegisterFormErrors = validateLoginForm(email, password);
  const nameError = validateDisplayName(displayName);
  if (nameError) {
    errors.displayName = nameError;
  }
  const passwordError = validatePassword(password);
  if (passwordError) {
    errors.password = passwordError;
  }
  return errors;
}

export function hasErrors(errors: object): boolean {
  return Object.values(errors).some((message) => message !== undefined);
}

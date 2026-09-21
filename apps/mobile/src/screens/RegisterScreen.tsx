// Phase 5 — Register screen. Wired to POST /v1/auth/register via AuthProvider.

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { ApiError, apiErrorMessage } from '../api';
import { useAuth } from '../auth';
import { Button, Screen, TextInput } from '../components';
import { colors, fontSize, fontWeight, spacing } from '../theme';
import { hasErrors, validateRegisterForm } from '../utils/validation';
import type { RegisterFormErrors } from '../utils/validation';

export function RegisterScreen() {
  const { signUp } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<RegisterFormErrors>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const clearField = (field: keyof RegisterFormErrors) => {
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const handleSubmit = async () => {
    const trimmedEmail = email.trim();
    const trimmedName = displayName.trim();
    const formErrors = validateRegisterForm(trimmedName, trimmedEmail, password);
    setErrors(formErrors);
    setApiError(null);
    if (hasErrors(formErrors)) {
      return;
    }
    setSubmitting(true);
    try {
      await signUp(trimmedEmail, password, trimmedName);
      // Navigation is driven by auth state; nothing to do here on success.
    } catch (error) {
      if (error instanceof ApiError && error.fieldErrors.length > 0) {
        const mapped: RegisterFormErrors = {};
        for (const fieldError of error.fieldErrors) {
          const field = fieldError.field;
          if (field === 'email' || field === 'password' || field === 'displayName') {
            mapped[field] = fieldError.message;
          }
        }
        if (Object.keys(mapped).length > 0) {
          setErrors(mapped);
          setSubmitting(false);
          return;
        }
      }
      setApiError(apiErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen testID="register-screen">
      <View style={styles.header}>
        <Text style={styles.title}>Create your account</Text>
        <Text style={styles.subtitle}>One account for all your music.</Text>
      </View>

      {apiError ? (
        <View style={styles.banner} testID="register-error-banner">
          <Text style={styles.bannerText}>{apiError}</Text>
        </View>
      ) : null}

      <View style={styles.field}>
        <TextInput
          label="Display name"
          testID="register-display-name"
          value={displayName}
          onChangeText={(value) => {
            setDisplayName(value);
            clearField('displayName');
          }}
          error={errors.displayName}
          placeholder="What should we call you?"
          textContentType="nickname"
          autoComplete="name"
          returnKeyType="next"
        />
      </View>
      <View style={styles.field}>
        <TextInput
          label="Email"
          testID="register-email"
          value={email}
          onChangeText={(value) => {
            setEmail(value);
            clearField('email');
          }}
          error={errors.email}
          placeholder="you@example.com"
          keyboardType="email-address"
          textContentType="emailAddress"
          autoComplete="email"
          returnKeyType="next"
        />
      </View>
      <View style={styles.field}>
        <TextInput
          label="Password"
          testID="register-password"
          value={password}
          onChangeText={(value) => {
            setPassword(value);
            clearField('password');
          }}
          error={errors.password}
          placeholder="At least 12 characters"
          secureTextEntry
          textContentType="newPassword"
          autoComplete="password-new"
          returnKeyType="go"
          onSubmitEditing={handleSubmit}
        />
      </View>

      <View style={styles.submit}>
        <Button
          title="Create account"
          testID="register-submit"
          onPress={handleSubmit}
          loading={submitting}
        />
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>Already have an account? </Text>
        <Link href="/(auth)/login" asChild>
          <Text style={styles.footerLink} accessibilityRole="link">
            Log in
          </Text>
        </Link>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { marginTop: spacing.xl, marginBottom: spacing.lg },
  title: { color: colors.text, fontSize: fontSize.xxl, fontWeight: fontWeight.bold },
  subtitle: { color: colors.textMuted, fontSize: fontSize.md, marginTop: spacing.xs },
  banner: {
    backgroundColor: colors.errorMuted,
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  bannerText: { color: colors.error, fontSize: fontSize.sm },
  field: { marginBottom: spacing.md },
  submit: { marginTop: spacing.sm },
  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: spacing.lg },
  footerText: { color: colors.textMuted, fontSize: fontSize.sm },
  footerLink: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
});

// Phase 5 — Login screen. Wired to POST /v1/auth/login via AuthProvider.

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { ApiError, apiErrorMessage } from '../api';
import { useAuth } from '../auth';
import { Button, Screen, TextInput } from '../components';
import { colors, fontSize, fontWeight, spacing } from '../theme';
import { hasErrors, validateLoginForm } from '../utils/validation';
import type { LoginFormErrors } from '../utils/validation';

export function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<LoginFormErrors>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const updateEmail = (value: string) => {
    setEmail(value);
    setErrors((prev) => ({ ...prev, email: undefined }));
  };

  const updatePassword = (value: string) => {
    setPassword(value);
    setErrors((prev) => ({ ...prev, password: undefined }));
  };

  const handleSubmit = async () => {
    const trimmedEmail = email.trim();
    const formErrors = validateLoginForm(trimmedEmail, password);
    setErrors(formErrors);
    setApiError(null);
    if (hasErrors(formErrors)) {
      return;
    }
    setSubmitting(true);
    try {
      await signIn(trimmedEmail, password);
      // Navigation is driven by auth state; nothing to do here on success.
    } catch (error) {
      if (error instanceof ApiError && error.fieldErrors.length > 0) {
        const mapped: LoginFormErrors = {};
        for (const fieldError of error.fieldErrors) {
          if (fieldError.field === 'email' || fieldError.field === 'password') {
            mapped[fieldError.field] = fieldError.message;
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
    <Screen testID="login-screen">
      <View style={styles.header}>
        <Text style={styles.title}>Welcome back</Text>
        <Text style={styles.subtitle}>Log in to keep the music flowing.</Text>
      </View>

      {apiError ? (
        <View
          style={styles.banner}
          testID="login-error-banner"
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
        >
          <Text style={styles.bannerText}>{apiError}</Text>
        </View>
      ) : null}

      <View style={styles.field}>
        <TextInput
          label="Email"
          required
          testID="login-email"
          value={email}
          onChangeText={updateEmail}
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
          required
          testID="login-password"
          value={password}
          onChangeText={updatePassword}
          error={errors.password}
          placeholder="Your password"
          secureTextEntry
          textContentType="password"
          autoComplete="password"
          returnKeyType="go"
          onSubmitEditing={handleSubmit}
        />
      </View>

      <View style={styles.submit}>
        <Button title="Log in" testID="login-submit" onPress={handleSubmit} loading={submitting} />
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>New here? </Text>
        <Link href="/(auth)/register" asChild>
          <Text style={styles.footerLink} accessibilityRole="link">
            Create an account
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

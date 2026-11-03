export async function accountApi<T>(
  path = '',
  body?: object,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/auth/account${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    ...(signal ? { signal } : {}),
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.message ?? 'Unable to update your account. Please try again.',
    );
  return data as T;
}

export const securityEventLabels: Record<string, string> = {
  'account.created': 'Account created',
  'sign_in.succeeded': 'Signed in',
  'sign_in.failed': 'Failed sign-in attempt',
  sign_out: 'Signed out',
  'password.changed': 'Password changed',
  'password.reset': 'Password reset by email',
  'email.change_requested': 'Sign-in email change requested',
  'email.change_cancelled': 'Sign-in email change cancelled',
  'email.changed': 'Sign-in email changed',
  'session.revoked': 'Signed out another device',
  'sessions.revoked_others': 'Signed out all other devices',
  'export.created': 'Data export downloaded',
  'deletion.scheduled': 'Account deletion scheduled',
  'deletion.cancelled': 'Account deletion cancelled',
  'account.deleted': 'Account deleted',
};

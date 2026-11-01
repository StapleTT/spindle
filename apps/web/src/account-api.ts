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

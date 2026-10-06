export default {
  mobileNav: {
    ariaLabel: 'Bottom navigation',
    files: 'Files',
    texts: 'Texts',
    shares: 'Shares',
    more: 'More',
  },
  more: {
    title: 'More',
    subtitle:
      'Low-frequency admin links and account actions live here so mobile does not depend on the sidebar.',
    sections: {
      admin: 'Admin links',
      account: 'Account',
      appearance: 'Appearance and language',
      session: 'Session',
    },
    adminHint: 'Admin only',
    adminDescription:
      'These pages keep the existing desktop capability while staying basically usable on mobile.',
    emptyAdmin: 'This account has no extra admin links.',
    account: {
      username: 'Username',
      role: 'Role',
    },
    password: {
      sectionTitle: 'Change password',
      required: 'Please fill in the current and new password',
      currentPlaceholder: 'Current password',
      newPlaceholder: 'New password (at least 8 characters)',
      confirmPlaceholder: 'Confirm new password',
      submit: 'Change password',
      changed: 'Password changed. Please sign in again with the new password',
      minLength: 'New password must be at least 8 characters',
      mismatch: 'The two new passwords do not match',
      sameAsCurrent: 'New password must differ from the current password',
    },
    usage: {
      sectionTitle: 'Storage usage',
      globalScope: 'Global usage',
      userScope: 'My quota',
      usedSpace: 'Used space',
      totalSpace: 'Total space',
      fileCount: 'Files',
      retry: 'Retry',
    },
    actions: {
      open: 'Open',
      toggleTheme: 'Toggle theme mode',
      toggleLanguage: 'Switch language',
      cycleUiTheme: 'Switch UI theme',
      logout: 'Log out',
    },
    mobileSheet: {
      close: 'Close more menu',
      language: 'Language',
      lightDark: 'Light/Dark',
      theme: 'Theme',
    },
    uiThemeLabel: 'UI theme: {value}',
  },
}

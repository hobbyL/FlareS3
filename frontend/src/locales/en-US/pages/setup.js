export default {
  setup: {
    title: 'Storage',
    help: 'Usage tips',
    subtitle:
      'Manage multiple storage configs (Cloudflare R2 / WebDAV / Koofr), set a default config, and choose which config to use when uploading files.',
    actions: {
      addConfig: 'Add config',
      refreshList: 'Refresh',
    },
    health: {
      title: 'Configuration health',
      labels: {
        configCount: 'Config count',
        defaultConfig: 'Default config',
        uploadReady: 'Upload ready',
      },
      values: {
        yes: 'Yes',
        no: 'No',
        notSet: 'Not set',
      },
      notices: {
        missingUploadConfigTitle: 'No upload target configured',
        missingUploadConfigContent:
          'Create at least one R2 config first, otherwise users cannot upload files.',
        missingDefaultConfigTitle: 'Default upload config is missing',
        missingDefaultConfigContent:
          'Upload configs already exist, but no default config is selected. Set one to avoid failed upload requests.',
        invalidDefaultConfigTitle: 'Default config reference is invalid',
        invalidDefaultConfigContent:
          'The saved default config no longer exists in the current config list. Please set the default config again.',
        readyTitle: 'Upload configuration is ready',
        readyContent:
          'At least one usable config exists, and a default upload config has been selected.',
      },
    },
    state: {
      loading: 'Loading...',
      emptyTitle: 'No configs',
      emptyContent: 'No storage configs yet. Click "Add config" to create one.',
      defaultTag: 'Default',
    },
    labels: {
      configType: 'Config type',
      bucket: 'Bucket',
      totalSpace: 'Total',
      usedSpace: 'Used',
      usagePercent: 'Usage',
      configId: 'Config ID',
      name: 'Name',
      endpoint: 'Endpoint URL',
      bucketName: 'Bucket name',
      quotaGb: 'Total quota (GB)',
      accessKeyId: 'Access Key ID',
      accessKeyIdOptional: 'Access Key ID (leave blank to keep)',
      secretAccessKey: 'Secret Access Key',
      secretAccessKeyOptional: 'Secret Access Key (leave blank to keep)',
      remotePath: 'Remote Directory',
      username: 'Username',
      usernameOptional: 'Username (leave blank to keep)',
      password: 'Password',
      passwordOptional: 'Password (leave blank to keep)',
    },
    placeholders: {
      name: 'e.g. Production',
      endpoint: 'https://<account_id>.r2.cloudflarestorage.com',
      bucketName: 'Bucket name',
      quotaGb: 'e.g. 10',
      accessKeyId: 'R2 access key ID',
      secretAccessKey: 'R2 secret access key',
      webdavEndpoint: 'https://nextcloud.example.com/remote.php/dav/files/user',
      koofrEndpoint: 'https://app.koofr.net/dav/Koofr',
      remotePath: 'e.g. /flares3, blank for root',
      webdavUsername: 'Username',
      koofrUsername: 'Email account',
      webdavPassword: 'Password',
    },
    hint: {
      title: 'Tips',
      endpointFormatPrefix: 'R2 endpoint URL format:',
      endpointFormat: 'R2 endpoint URL format: {url}',
      tokenCreatePrefix: 'Create access keys in Cloudflare Dashboard at',
      tokenCreateSuffix: '(Object Read/Write required).',
      tokenCreate:
        'Create access keys in Cloudflare Dashboard at {path} (Object Read/Write required).',
      koofrEndpointPrefix: 'Koofr WebDAV endpoint is typically',
      koofrAppPassword: 'Use a Koofr app-specific password (generate one in Account Preferences).',
      webdavEndpointHint: 'Enter the WebDAV service endpoint URL, ensure it supports PROPFIND.',
    },
    modal: {
      createTitle: 'Create storage config',
      editTitle: 'Edit storage config',
      save: 'Save',
    },
    aria: {
      testConnection: 'Test connection',
      setDefault: 'Set default',
      edit: 'Edit',
      notEditable: 'This config is read-only',
      delete: 'Delete',
    },
    validation: {
      required: 'Please fill in name and endpoint',
      quotaInvalid: 'Quota must be a number greater than 0 (GB)',
      createNeedKeys: 'Access Key and Secret Key are required for new configs',
      koofrNeedMountId: 'Mount ID is required for Koofr configs',
      createNeedCredentials: 'Username and password are required for new configs',
    },
    messages: {
      loadFailed: 'Failed to load configs',
      loadSecretsFailed: 'Failed to load config secrets',
      defaultUpdated: 'Default config updated',
      setDefaultFailed: 'Failed to set default config',
      testSuccess: 'Connection test succeeded',
      testFailed: 'Connection test failed',
      createSuccess: 'Config created',
      updateSuccess: 'Config updated',
      saveFailed: 'Save failed',
      deleteConfirm: 'Delete this config? Make sure no files are linked to it.',
      deleteSuccess: 'Config deleted',
      deleteFailed: 'Failed to delete config',
    },
    usageTips: {
      usage: {
        title: 'Usage notes',
        content:
          'Displayed usage is calculated from the local database and may differ from actual usage.',
      },
      storage: {
        title: 'Storage',
        content:
          'Currently using Cloudflare R2 free tier with 10GB total. Additional usage may incur fees.',
      },
      expiry: {
        title: 'Expiry',
        content:
          'Files are automatically deleted based on the expiration setting. Download important files in time.',
      },
      bandwidth: {
        title: 'Bandwidth',
        content: 'R2 does not charge egress fees; downloads are free.',
      },
    },
  },
}

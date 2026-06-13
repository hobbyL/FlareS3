import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSetupStatusAlerts,
  buildSetupStatusItems,
  buildSetupStatusModel,
} from "../../../frontend/src/utils/setupStatus.js";

test("buildSetupStatusModel flags missing upload config", () => {
  assert.deepEqual(buildSetupStatusModel({ configs: [], r2Options: {} }), {
    configCount: 0,
    defaultConfigId: null,
    hasUploadConfig: false,
    hasDefaultConfig: false,
    defaultConfigMissing: false,
    defaultConfigInvalid: false,
    notices: [{ code: "missing_upload_config", type: "warning" }],
  });
});

test("buildSetupStatusModel flags missing default config when configs exist", () => {
  assert.deepEqual(
    buildSetupStatusModel({
      configs: [{ id: "cfg-1" }],
      r2Options: { default_config_id: null },
    }),
    {
      configCount: 1,
      defaultConfigId: null,
      hasUploadConfig: true,
      hasDefaultConfig: false,
      defaultConfigMissing: true,
      defaultConfigInvalid: false,
      notices: [{ code: "missing_default_upload_config", type: "warning" }],
    },
  );
});

test("buildSetupStatusModel recognizes valid and invalid default config references", () => {
  assert.deepEqual(
    buildSetupStatusModel({
      configs: [{ id: "cfg-1" }, { id: "cfg-2" }],
      r2Options: { default_config_id: "cfg-2" },
    }),
    {
      configCount: 2,
      defaultConfigId: "cfg-2",
      hasUploadConfig: true,
      hasDefaultConfig: true,
      defaultConfigMissing: false,
      defaultConfigInvalid: false,
      notices: [{ code: "upload_ready", type: "success" }],
    },
  );

  assert.deepEqual(
    buildSetupStatusModel({
      configs: [{ id: "cfg-1" }],
      r2Options: { default_config_id: "cfg-404" },
    }),
    {
      configCount: 1,
      defaultConfigId: "cfg-404",
      hasUploadConfig: true,
      hasDefaultConfig: true,
      defaultConfigMissing: false,
      defaultConfigInvalid: true,
      notices: [{ code: "invalid_default_upload_config", type: "error" }],
    },
  );
});

test("buildSetupStatusItems formats config summary for descriptions", () => {
  const model = buildSetupStatusModel({
    configs: [{ id: "cfg-1" }, { id: "cfg-2" }],
    r2Options: { default_config_id: "cfg-2" },
  });

  assert.deepEqual(
    buildSetupStatusItems(model, {
      labels: {
        configCount: "Config count",
        defaultConfig: "Default config",
        uploadReady: "Upload ready",
      },
      values: {
        yes: "Yes",
        no: "No",
        notSet: "Not set",
      },
    }),
    [
      { key: "configCount", label: "Config count", value: "2" },
      { key: "defaultConfig", label: "Default config", value: "cfg-2" },
      { key: "uploadReady", label: "Upload ready", value: "Yes" },
    ],
  );
});

test("buildSetupStatusAlerts maps notice codes to translated alert view models", () => {
  const model = buildSetupStatusModel({
    configs: [{ id: "cfg-1" }],
    r2Options: { default_config_id: null },
  });

  assert.deepEqual(
    buildSetupStatusAlerts(model, {
      notices: {
        missingUploadConfigTitle: "No upload target configured",
        missingUploadConfigContent: "Create at least one R2 config first.",
        missingDefaultConfigTitle: "Default upload config is missing",
        missingDefaultConfigContent: "Select a default config.",
        invalidDefaultConfigTitle: "Default config reference is invalid",
        invalidDefaultConfigContent: "Please set the default config again.",
        readyTitle: "Upload configuration is ready",
        readyContent: "Uploads can proceed normally.",
      },
    }),
    [
      {
        code: "missing_default_upload_config",
        type: "warning",
        title: "Default upload config is missing",
        content: "Select a default config.",
      },
    ],
  );
});

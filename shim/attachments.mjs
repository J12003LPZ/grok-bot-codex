// Chat attachments. The hosted backend hands the desktop a cloud upload
// target; with no cloud storage here, the shim tells the desktop to send the
// file to the Bot's computer instead (USE_BOX), which the app supports.
export function attachmentHandlers() {
  return {
    BeginGrokBotAttachmentUpload: () => ({
      mode: "GrokBotAttachmentUploadMode_USE_BOX",
      useBoxReason: "local_backend",
    }),
  };
}

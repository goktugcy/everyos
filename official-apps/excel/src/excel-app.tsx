import { XlsxEditor } from "@betteroffice/xlsx-react";
import en from "@betteroffice/xlsx-i18n/en";
import { OfficeChrome, useOffice, engineMessages } from "@everyos/office-core";
import { useT } from "@everyos/app-ui";
import { useEffect, useRef, useMemo } from "react";

export function ExcelApp() {
  const t = useT();
  const messages = useMemo(() => engineMessages(en, t), [t]);
  const controller = useOffice("xlsx");
  const callbacks = useRef(controller);
  const ready = useRef(false);
  useEffect(() => {
    callbacks.current = controller;
  }, [controller]);
  const doc = controller.document;
  return (
    <OfficeChrome controller={controller}>
      {doc ? (
        <XlsxEditor
          key={doc.id}
          file={doc.bytes}
          fileName={doc.name}
          className="office-editor"
          style={{ height: "100%" }}
          experimentalWorkerOpen={false}
          downloadOnSave={false}
          i18n={messages}
          onReady={(api) => {
            ready.current = true;
            callbacks.current.exporter.current = async () => new Uint8Array(await api.save());
            callbacks.current.setReady(true);
            return () => {
              ready.current = false;
            };
          }}
          onDocumentChange={() => {
            if (ready.current) callbacks.current.change();
          }}
          onSaveRequest={async () => {
            await callbacks.current.save();
            return false;
          }}
          onError={(error) => callbacks.current.report(error)}
        />
      ) : null}
    </OfficeChrome>
  );
}

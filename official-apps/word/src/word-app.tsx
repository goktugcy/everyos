import "@betteroffice/docx-react/styles.css";
import { DocxEditor, type DocxEditorRef } from "@betteroffice/docx-react";
import { configureDefaultFonts } from "@betteroffice/docx/layout";
import * as fonts from "@betteroffice/fonts";
import en from "@betteroffice/docx-i18n/en";
import { OfficeChrome, OfficeError, useOffice, engineMessages } from "@everyos/office-core";
import { useT } from "@everyos/app-ui";
import { useEffect, useRef, useMemo } from "react";

configureDefaultFonts({ fonts, baseUrl: new URL("fonts/", document.baseURI).href });

export function WordApp() {
  const t = useT();
  const messages = useMemo(() => engineMessages(en, t), [t]);
  const controller = useOffice("docx");
  const editor = useRef<DocxEditorRef>(null);
  const callbacks = useRef(controller);
  const ready = useRef(false);
  useEffect(() => {
    callbacks.current = controller;
  }, [controller]);
  const id = controller.document?.id;
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let frame = 0;
    ready.current = false;
    const poll = () => {
      if (cancelled) return;
      const ref = editor.current;
      if (!ref?.getDocument()) {
        frame = requestAnimationFrame(poll);
        return;
      }
      ready.current = true;
      callbacks.current.exporter.current = async () => {
        const value = await editor.current?.save();
        if (!(value instanceof ArrayBuffer)) throw new OfficeError("invalid");
        return new Uint8Array(value);
      };
      callbacks.current.setReady(true);
    };
    frame = requestAnimationFrame(poll);
    return () => {
      cancelled = true;
      ready.current = false;
      cancelAnimationFrame(frame);
    };
  }, [id]);
  const doc = controller.document;
  return (
    <OfficeChrome controller={controller}>
      {doc ? (
        <DocxEditor
          key={doc.id}
          ref={editor}
          documentBuffer={doc.bytes}
          documentName={doc.name}
          author={t("office.author")}
          className="office-editor"
          experimentalWorkerOpen={false}
          downloadOnSave={false}
          showFileOpen={false}
          i18n={messages}
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

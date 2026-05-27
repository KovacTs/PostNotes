import { 
  useCreateBlockNote, 
  getDefaultReactSlashMenuItems,
  SuggestionMenuController
} from "@blocknote/react";
import { filterSuggestionItems, insertOrUpdateBlock } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { Minus, ChevronRight, Quote } from "lucide-react";
import React from 'react';

interface EditorProps {
  initialContent: any;
  onChange: (content: any) => void;
}

export default function Editor({ initialContent, onChange }: EditorProps) {
  // We recreate the editor instance cleanly using React keys on parent component when active note changes
  // Using the 100% stable, default, native BlockNote schema
  const editor = useCreateBlockNote({
    initialContent: initialContent && initialContent.length > 0 ? initialContent : undefined,
  });

  // Define Custom Slash Menu Suggestion Items using stable native blocks
  const getCustomSlashMenuItems = (editor: any) => {
    const defaultItems = getDefaultReactSlashMenuItems(editor);
    
    // Custom Toggle List Item (Native block 'toggleListItem')
    const toggleItem = {
      title: "Desplegable (Toggle List)",
      onItemClick: () => {
        insertOrUpdateBlock(editor, {
          type: "toggleListItem",
        });
      },
      aliases: ["toggle", "desplegable", "lista", "fold"],
      group: "Básicos",
      icon: <ChevronRight size={18} />,
      subtext: "Lista con contenido ocultable",
    };

    // Custom Divider Item (Native block 'divider')
    const dividerItem = {
      title: "Separador (Divider)",
      onItemClick: () => {
        insertOrUpdateBlock(editor, {
          type: "divider",
        });
      },
      aliases: ["divider", "separador", "hr", "linea", "barra"],
      group: "Otros",
      icon: <Minus size={18} />,
      subtext: "Línea horizontal divisoria",
    };

    // Custom Quote/Highlight Item (Native block 'quote')
    const quoteItem = {
      title: "Destacado (Quote)",
      onItemClick: () => {
        insertOrUpdateBlock(editor, {
          type: "quote",
        });
      },
      aliases: ["quote", "destacado", "cita", "caja", "callout"],
      group: "Básicos",
      icon: <Quote size={18} />,
      subtext: "Bloque de cita o texto destacado",
    };

    return [
      ...defaultItems,
      toggleItem,
      dividerItem,
      quoteItem,
    ];
  };

  return (
    <MantineProvider defaultColorScheme="dark">
      <div className="editor-container">
        <BlockNoteView
          editor={editor}
          onChange={() => {
            onChange(editor.document);
          }}
          theme="dark"
          slashMenu={false}
        >
          <SuggestionMenuController
            triggerCharacter={"/"}
            getItems={async (query) =>
              filterSuggestionItems(getCustomSlashMenuItems(editor), query)
            }
          />
        </BlockNoteView>
      </div>
    </MantineProvider>
  );
}

import React from 'react';
import { Pressable, Text, View, ViewStyle } from 'react-native';
import { C, F } from '../theme';

type Option = { id: string; label: string; category?: string };

// A single pill. Tappable when onPress is given (selectable), otherwise a
// read-only tag. `on` shows the selected/filled state.
export function Chip({ label, on, onPress }: { label: string; on?: boolean; onPress?: () => void }) {
  const body = (
    <View
      style={{
        paddingHorizontal: 12, paddingVertical: 7, borderRadius: 15, margin: 4,
        backgroundColor: on ? C.yellow : C.white,
        borderWidth: 2.5, borderColor: on ? C.brown : '#C89A62',
      }}
    >
      <Text style={{ fontFamily: F.display, fontSize: 13, color: on ? C.darkInk : C.brown }}>
        {label}
      </Text>
    </View>
  );
  return onPress ? <Pressable onPress={onPress}>{body}</Pressable> : body;
}

export function ChipRow({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', flexWrap: 'wrap' }, style]}>{children}</View>;
}

// Keep the categories in the order the server sent them, without assuming the
// options are pre-sorted.
function groupByCategory(options: Option[]): [string, Option[]][] {
  const order: string[] = [];
  const map = new Map<string, Option[]>();
  for (const o of options) {
    const cat = o.category ?? 'More';
    if (!map.has(cat)) { map.set(cat, []); order.push(cat); }
    map.get(cat)!.push(o);
  }
  return order.map((cat) => [cat, map.get(cat)!]);
}

// A multi-select field over {id,label,category} options, writing selected ids to
// `value`. Renders a labelled section per category so a long list stays scannable.
export function InterestPicker({
  options, value, onChange,
}: {
  options: Option[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const groups = groupByCategory(options);
  return (
    <View>
      {groups.map(([cat, items]) => (
        <View key={cat} style={{ marginBottom: 12 }}>
          <Text
            style={{
              fontFamily: F.display, fontSize: 12, color: C.labelOrange,
              letterSpacing: 0.5, marginBottom: 2, marginLeft: 4,
            }}
          >
            {cat}
          </Text>
          <ChipRow>
            {items.map((o) => (
              <Chip key={o.id} label={o.label} on={value.includes(o.id)} onPress={() => toggle(o.id)} />
            ))}
          </ChipRow>
        </View>
      ))}
    </View>
  );
}

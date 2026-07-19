import React from 'react';
import { Pressable, Text, View, ViewStyle } from 'react-native';
import { C, F } from '../theme';

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

// A multi-select field over {id,label} options, writing selected ids to `value`.
export function InterestPicker({
  options, value, onChange,
}: {
  options: { id: string; label: string }[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <ChipRow>
      {options.map((o) => (
        <Chip key={o.id} label={o.label} on={value.includes(o.id)} onPress={() => toggle(o.id)} />
      ))}
    </ChipRow>
  );
}

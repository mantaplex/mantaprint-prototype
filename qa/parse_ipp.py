import sys
import struct

def parse_ipp(path):
    print("=" * 50)
    print("=== File:", path)
    print("=" * 50)
    with open(path, "rb") as f:
        data = f.read()
    version = f"{data[0]}.{data[1]}"
    op_or_status = struct.unpack(">H", data[2:4])[0]
    req_id = struct.unpack(">I", data[4:8])[0]
    print(f"Version: {version}, Op/Status: 0x{op_or_status:04x}, ReqID: {req_id}")
    offset = 8
    curr_tag = None
    curr_attr = None
    indent_level = 1
    
    tags = {
        1: "operation-attributes-tag",
        2: "job-attributes-tag",
        3: "end-of-attributes-tag",
        4: "printer-attributes-tag",
        5: "unsupported-attributes-tag"
    }
    
    while offset < len(data):
        tag = data[offset]
        offset += 1
        if tag in tags:
            curr_tag = tags[tag]
            print(f"[{curr_tag}]")
            if tag == 3:
                break
            continue
        
        name_len = struct.unpack(">H", data[offset:offset+2])[0]
        offset += 2
        name = data[offset:offset+name_len].decode("utf-8", errors="replace")
        offset += name_len
        
        val_len = struct.unpack(">H", data[offset:offset+2])[0]
        offset += 2
        raw_val = data[offset:offset+val_len]
        offset += val_len
        
        val_str = ""
        # Types:
        if tag in (0x21, 0x23):
            if val_len == 4:
                val_str = str(struct.unpack(">i", raw_val)[0])
            else:
                val_str = raw_val.hex()
        elif tag == 0x22:
            val_str = str(bool(raw_val[0])) if val_len == 1 else raw_val.hex()
        elif tag in (0x41, 0x42, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49):
            val_str = raw_val.decode("utf-8", errors="replace")
        elif tag == 0x34: # begCollection
            val_str = "{"
            indent_level += 1
        elif tag == 0x37: # endCollection
            indent_level = max(1, indent_level - 1)
            val_str = "}"
        elif tag == 0x4a: # memberAttrName
            val_str = raw_val.decode("utf-8", errors="replace")
        elif tag == 0x31: # dateTime
            if val_len == 11:
                year, mon, day, hour, minute, sec, dsec, dtz, tzhr, tzmin = struct.unpack(">HBBBBBBcBB", raw_val)
                dtz_str = dtz.decode("ascii", errors="replace")
                val_str = f"{year:04d}-{mon:02d}-{day:02d}T{hour:02d}:{minute:02d}:{sec:02d}.{dsec}{dtz_str}{tzhr:02d}:{tzmin:02d}"
            else:
                val_str = raw_val.hex()
        else:
            val_str = f"tag(0x{tag:02x}, len={val_len}): {raw_val.hex()}"
            
        indent = "  " * indent_level
        if tag == 0x4a:
            print(f"{indent}-> member: {val_str}")
        else:
            attr_display = name if name else f"(more {curr_attr})"
            if name:
                curr_attr = name
            print(f"{indent}{attr_display} = {val_str}")

if __name__ == "__main__":
    for p in sys.argv[1:]:
        parse_ipp(p)

---
title: Firecracker Setup Guide
---

# Firecracker Setup Guide

This guide explains how to set up Firecracker microVM for use with mikan sandbox mode.

Warning: Firecracker support in mikan is still in very early alpha. This guide is kept for experimentation and validation work; it is not the recommended sandbox path for normal development or production use yet. Prefer `image:<image>` unless you are explicitly testing Firecracker.

## Prerequisites

- Linux host with KVM support
- Root/sudo access for network configuration
- SSH key-based authentication to VM

## Installation Steps

### 1. Install Firecracker Binary

```bash
# Download and install Firecracker
mkdir -p /home/gemini/firecracker
cp release-v1.15.0-x86_64/firecracker-v1.15.0-x86_64 /usr/local/bin/firecracker
chmod +x /usr/local/bin/firecracker

# Verify
firecracker --version
```

### 2. Download Kernel and Rootfs

Follow the official Firecracker getting-started guide to download kernel and rootfs:

```bash
cd /home/gemini/firecracker

# Get CI version from latest release
ARCH="x86_64"
release_url="https://github.com/firecracker-microvm/firecracker/releases"
CI_VERSION=$(basename $(curl -fsSLI -o /dev/null -w %{url_effective} ${release_url}/latest))

# Download kernel
latest_kernel_key=$(curl "http://spec.ccfc.min.s3.amazonaws.com/?prefix=firecracker-ci/${CI_VERSION}/$ARCH/vmlinux-&list-type=2" 2>/dev/null | \
    grep -oP "(?<=<Key>)(firecracker-ci/${CI_VERSION}/$ARCH/vmlinux-[0-9]+\.[0-9]+\.[0-9]{1,3})(?=</Key>)" | sort -V | tail -1)
wget "https://s3.amazonaws.com/spec.ccfc.min/${latest_kernel_key}" -O vmlinux

# Download rootfs squashfs
latest_ubuntu_key=$(curl "http://spec.ccfc.min.s3.amazonaws.com/?prefix=firecracker-ci/${CI_VERSION}/$ARCH/ubuntu-&list-type=2" 2>/dev/null | \
    grep -oP "(?<=<Key>)(firecracker-ci/${CI_VERSION}/$ARCH/ubuntu-[0-9]+\.[0-9]+\.squashfs)(?=</Key>)" | sort -V | tail -1)
wget "https://s3.amazonaws.com/spec.ccfc.min/${latest_ubuntu_key}" -O ubuntu-24.04.squashfs.upstream
```

### 3. Extract and Configure Rootfs

```bash
cd /home/gemini/firecracker

# Extract squashfs
unsquashfs ubuntu-24.04.squashfs.upstream

# Generate SSH key for VM access
ssh-keygen -f id_rsa -N "" -q

# Add public key to rootfs
mkdir -p squashfs-root/root/.ssh
cp id_rsa.pub squashfs-root/root/.ssh/authorized_keys

# Create ext4 filesystem
truncate -s 1G ubuntu-24.04.ext4
mkfs.ext4 -d squashfs-root -F ubuntu-24.04.ext4
```

### 4. Start Firecracker (Two Terminals Required)

#### Terminal 1: Setup Network and Start Firecracker

```bash
cd /home/gemini/firecracker

# Setup tap interface
sudo ip link del tap0 2>/dev/null || true
sudo ip tuntap add dev tap0 mode tap
sudo ip addr add 172.16.0.1/30 dev tap0
sudo ip link set dev tap0 up

# Enable IP forwarding
sudo sh -c "echo 1 > /proc/sys/net/ipv4/ip_forward"
sudo iptables -P FORWARD ACCEPT

# Start firecracker
sudo firecracker --api-sock /tmp/firecracker.socket --enable-pci
```

#### Terminal 2: Configure VM

```bash
cd /home/gemini/firecracker
API_SOCKET="/tmp/firecracker.socket"

# Set log file
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"log_path": "./firecracker.log", "level": "Debug", "show_level": true, "show_log_origin": true}' \
    "http://localhost/logger"

# Set boot source
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"kernel_image_path": "./vmlinux", "boot_args": "console=ttyS0 reboot=k panic=1"}' \
    "http://localhost/boot-source"

# Set rootfs
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"drive_id": "rootfs", "path_on_host": "./ubuntu-24.04.ext4", "is_root_device": true, "is_read_only": false}' \
    "http://localhost/drives/rootfs"

# Set network interface (MAC determines IP: 06:00:AC:10:00:02 → 172.16.0.2)
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"iface_id": "net1", "guest_mac": "06:00:AC:10:00:02", "host_dev_name": "tap0"}' \
    "http://localhost/network-interfaces/net1"

# Start VM
sleep 0.5
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"action_type": "InstanceStart"}' \
    "http://localhost/actions"

# Wait for boot
sleep 3s

# Setup guest network and DNS
ssh -i ./id_rsa -o StrictHostKeyChecking=no root@172.16.0.2 \
    "ip route add default via 172.16.0.1 && echo 'nameserver 8.8.8.8' > /etc/resolv.conf"
```

### 5. Verify SSH Access

```bash
# Test SSH connection
ssh -i ./id_rsa root@172.16.0.2 "echo 'Connected!' && uname -a"

# Should see: Connected!
# Linux localhost 6.1.0... x86_64 GNU/Linux
```

## Usage with Mikan

Once the VM is running:

```bash
# Run mikan with Firecracker sandbox
mikan --sandbox=firecracker:172.16.0.2:/home/gemini/workspace /home/gemini/workspace

# With custom SSH user
mikan --sandbox=firecracker:172.16.0.2:/home/gemini/workspace:ubuntu /home/gemini/workspace

# With custom SSH port
mikan --sandbox=firecracker:172.16.0.2:/home/gemini/workspace:root:22 /home/gemini/workspace
```

## Shutdown

Inside the VM:

```bash
reboot
```

This gracefully shuts down Firecracker. To force kill:

```bash
sudo killall firecracker
```

## Troubleshooting

### KVM Access Denied

```bash
# Check KVM module
lsmod | grep kvm

# Grant access
sudo setfacl -m u:${USER}:rw /dev/kvm
# Or add user to kvm group
sudo usermod -aG kvm ${USER}
```

### VM Won't Boot

- Check logs: `tail -f /home/gemini/firecracker/firecracker.log`
- Verify kernel and rootfs paths are correct
- Ensure tap interface is up: `ip link show tap0`

### SSH Connection Refused

- Wait longer for VM to boot (try 10s)
- Check network: `ping 172.16.0.2`
- Verify SSH is running in VM: `ssh -v -i ./id_rsa root@172.16.0.2`

## Files Summary

| File                | Description                    |
| ------------------- | ------------------------------ |
| `vmlinux`           | Linux kernel for Firecracker   |
| `ubuntu-24.04.ext4` | Root filesystem (1GB)          |
| `id_rsa`            | SSH private key (keep secret!) |
| `id_rsa.pub`        | SSH public key                 |
| `firecracker.log`   | Firecracker execution log      |

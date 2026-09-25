import React, { useState } from 'react';
import { 
  Building2, 
  Plus, 
  Server, 
  MapPin, 
  Network, 
  Mail, 
  Edit3,
  Trash2,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react';
import { Card, CardHeader, PageHeader, StatusPill, Badge, SectionLabel, Modal } from '../ui/surfaces';
import { Button, Field } from '../ui/primitives';
import { MantaClient } from '../utils/api';
import { useToast } from '../ui/Toast';

export function SitesManager({ sites = [], hubs = [], onRefresh, t }) {
  const { showToast } = useToast();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingSite, setEditingSite] = useState(null);

  // Form fields
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [address, setAddress] = useState('');
  const [subnetCidr, setSubnetCidr] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const openCreate = () => {
    setEditingSite(null);
    setName('');
    setSlug('');
    setAddress('');
    setSubnetCidr('');
    setContactEmail('');
    setShowCreateModal(true);
  };

  const openEdit = (site) => {
    setEditingSite(site);
    setName(site.name || '');
    setSlug(site.slug || '');
    setAddress(site.address || '');
    setSubnetCidr(site.subnet_cidr || '');
    setContactEmail(site.contact_email || '');
    setShowCreateModal(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!name.trim() || !slug.trim()) {
      showToast('Name and Slug are required', 'warning');
      return;
    }
    setIsSaving(true);
    try {
      if (editingSite) {
        await MantaClient.updateSite(editingSite.id, {
          name: name.trim(),
          slug: slug.trim(),
          address: address.trim(),
          subnet_cidr: subnetCidr.trim(),
          contact_email: contactEmail.trim()
        });
        showToast(`Site '${name}' updated successfully`, 'success');
      } else {
        await MantaClient.createSite({
          name: name.trim(),
          slug: slug.trim(),
          address: address.trim(),
          subnet_cidr: subnetCidr.trim(),
          contact_email: contactEmail.trim()
        });
        showToast(`Site '${name}' created successfully`, 'success');
      }
      setShowCreateModal(false);
      onRefresh();
    } catch (err) {
      showToast(`Failed to save site: ${err.message}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (site) => {
    if (site.id === 'site_default') {
      showToast('Default site cannot be deleted', 'error');
      return;
    }
    if (!window.confirm(`Delete site '${site.name}'? Any assigned hubs will be moved to the default site.`)) return;
    try {
      await MantaClient.deleteSite(site.id);
      showToast(`Site '${site.name}' deleted`, 'info');
      onRefresh();
    } catch (err) {
      showToast(`Failed to delete site: ${err.message}`, 'error');
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title={t.sites?.title || 'Sites & Branch Hierarchy'}
        description={t.sites?.subtitle || 'Multi-tenant grouping, physical location management, and localized fleet metrics.'}
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={Plus}
            onClick={openCreate}
          >
            {t.sites?.btn_create_site || 'Register New Site'}
          </Button>
        }
      />

      {/* Sites Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {sites.map((site) => {
          const siteHubs = hubs.filter(h => h && h.site_id === site.id);
          const onlineCount = siteHubs.filter(h => h && h.is_online).length;
          const healthScore = siteHubs.length > 0 ? Math.round((onlineCount / siteHubs.length) * 100) : 100;

          return (
            <Card 
              key={site.id}
              className="flex flex-col justify-between hover:border-white/20 transition-all"
            >
              <div>
                {/* Header */}
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-xl bg-manta-500/10 border border-manta-500/20 text-manta-400">
                      <Building2 className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="font-bold text-sm text-white tracking-wide">{site.name}</h4>
                      <span className="text-[11px] font-mono text-slate-400">slug: /{site.slug}</span>
                    </div>
                  </div>

                  <StatusPill tone={healthScore >= 80 ? 'ok' : 'warn'}>
                    {healthScore}% Health
                  </StatusPill>
                </div>

                {/* Details Box */}
                <div className="p-3.5 rounded-xl bg-slate-950/40 border border-white/[0.05] space-y-2 text-xs">
                  <div className="flex items-center justify-between text-slate-300">
                    <span className="text-slate-400 flex items-center gap-1.5">
                      <Server className="w-3.5 h-3.5 text-manta-400" />
                      <span>{t.sites?.nodes_count || 'Appliance Hubs'}:</span>
                    </span>
                    <span className="font-mono font-bold text-white">
                      {siteHubs.length} <span className="text-slate-500 font-normal">({onlineCount} online)</span>
                    </span>
                  </div>

                  {site.subnet_cidr && (
                    <div className="flex items-center justify-between text-slate-300">
                      <span className="text-slate-400 flex items-center gap-1.5">
                        <Network className="w-3.5 h-3.5 text-cyan-400" />
                        <span>Subnet CIDR:</span>
                      </span>
                      <span className="font-mono text-[11px] text-cyan-300">{site.subnet_cidr}</span>
                    </div>
                  )}

                  {site.address && (
                    <div className="flex items-start gap-1.5 text-slate-400 pt-1 border-t border-white/[0.04]">
                      <MapPin className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-500" />
                      <span className="text-[11px] truncate">{site.address}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Actions Footer */}
              <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center justify-between">
                <span className="text-[10px] text-slate-500 font-mono">ID: {site.id}</span>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={Edit3}
                    onClick={() => openEdit(site)}
                  >
                    Edit
                  </Button>
                  {site.id !== 'site_default' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={Trash2}
                      className="text-rose-400 hover:text-rose-300 hover:bg-rose-500/10"
                      onClick={() => handleDelete(site)}
                    />
                  )}
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {/* Create / Edit Site Modal */}
      {showCreateModal && (
        <Modal
          isOpen={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          title={editingSite ? 'Edit Branch / Site' : (t.sites?.modal_create_title || 'Register New Branch / Site')}
          subtitle="Configure branch location, assigned IP subnet, and local contact"
          footer={
            <div className="flex items-center justify-end gap-2.5 w-full">
              <Button variant="secondary" size="sm" onClick={() => setShowCreateModal(false)}>
                {t.common?.cancel || 'Cancel'}
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={isSaving}
                onClick={handleSave}
              >
                {editingSite ? 'Update Site' : (t.sites?.btn_save_site || 'Save Site')}
              </Button>
            </div>
          }
        >
          <form onSubmit={handleSave} className="space-y-3.5">
            <Field label={t.sites?.input_site_name || 'Branch / Site Name'}>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Bandung HQ Branch"
                className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-manta-500/50"
              />
            </Field>

            <Field label={t.sites?.input_site_slug || 'Site Slug (Identifier)'}>
              <input
                type="text"
                required
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
                placeholder="e.g. bdo-branch-01"
                className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-manta-500/50 font-mono"
              />
            </Field>

            <Field label={t.sites?.input_site_cidr || 'Subnet CIDR Range'}>
              <input
                type="text"
                value={subnetCidr}
                onChange={(e) => setSubnetCidr(e.target.value)}
                placeholder="e.g. 192.168.10.0/24"
                className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-manta-500/50 font-mono"
              />
            </Field>

            <Field label={t.sites?.input_site_address || 'Physical Address'}>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="e.g. Jl. R.E. Martadinata No. 45, Bandung"
                className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-manta-500/50"
              />
            </Field>

            <Field label={t.sites?.input_contact || 'Branch Contact Email'}>
              <input
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                placeholder="e.g. it.ops@company.com"
                className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-manta-500/50"
              />
            </Field>
          </form>
        </Modal>
      )}
    </div>
  );
}
